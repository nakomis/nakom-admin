# Semantic projection pipeline (scratch)

Batch jobs that turn a pgvector corpus into 3D coordinates and clusters for the
semantic graph viewer. Feeds Taiga **MULTI-5** (HOME-307, HOME-308, ADMIN-11/12/13).

> **This location is temporary.** It lives here because the viewer it feeds lives
> here. When it becomes the periodic job it belongs in `home-servers/cal/`,
> deployed by Ansible rather than run by hand — Cal is cattle, not a pet, and has
> no Python toolchain by design (`python3-venv` isn't installed, so there is no
> `ensurepip`). Until then, run it from a Mac.

## Running

```bash
python3 -m venv .venv                 # Python 3.11 — see requirements.txt
./.venv/bin/pip install -r requirements.txt

./.venv/bin/python project_multi.py \
  --dsn "postgres://claude:claude@<luke-ip>:5432/claude_chats" \
  --out-prefix proj
```

Roughly 2 minutes for ~70k messages: ~82 s fetch, then five UMAP fits.
Generated `*.json` is gitignored — it regenerates faster than it would clone.

## What each script does

### Projection

| Script | Purpose |
|---|---|
| `project_multi.py` | **The main one.** One projection per author combination (`martin`, `claude`, `tool`, `martin-claude`, `all`). Drops scatter, emits no edges. |
| `project_corpus.py` | Single-corpus variant that *does* emit edges (kNN or threshold). Kept for the tiled-GEMM implementation and for cv-chat, which is small enough to want edges. |

### Enrichment — run after `project_multi.py`, in any order

Each reads the `projv2-*.json` files in place and adds one key. All three are
optional; the viewer degrades to a plainer map without them rather than failing.

| Script | Adds | Cost |
|---|---|---|
| `add_edges.py` | `edges` — intra-cluster kNN by **real cosine**, drawn when a cluster is selected. | ~80 s (the fetch), seconds of compute |
| `label_clusters.py` | `label` + `terms` — c-TF-IDF cluster names. `--ollama MODEL` turns the terms into English as a second pass. | ~2 s over 70k messages |
| `add_embeddings.py` | `emb` — PCA + int8 vectors so the browser can compute similarity live. `--shared-basis` writes one table for all five instead of one each. `--report` measures the compression. | ~80 s fetch, ~5 s compute |

Then pack: `python3 ../viewer/pack.py . graph.html`.

Two things these got wrong first time, both worth not repeating:

**Edges must come from the embeddings, not the coordinates.** Deriving them
from the projected 3D positions would be circular — asserting "these are
similar" using only the positions that already assert it — and would inherit
every distortion UMAP introduced.

**Labels must come from c-TF-IDF, not from an LLM shown a sample.** A sample of
a 3,000-message cluster is a guess about the other 2,990. c-TF-IDF asks the
question a label actually answers — frequent here, rare elsewhere — and is
deterministic and free.

### Author classification (HOME-309/310/311)

Run in this order — `ground_truth.py` first, everything else depends on its output.

| Script | Purpose |
|---|---|
| `ground_truth.py` | Exact labels from Claude Code transcripts. A genuine user message has a **string** `content`; a tool result has a **list** of `tool_result` blocks. Covers 27% of the corpus (transcripts only go back to 2026-06-24). |
| `train_author.py` | Trains logistic regression on those labels using embeddings already in the database. **93.6% accuracy, 93.3% balanced.** Writes `author_clf.joblib` (5 KB). |
| `llm_adjudicate.py` | LLM baseline via Ollama. `--benchmark N` grades it against ground truth; `--run` adjudicates the classifier's uncertainty band. |
| `prompt_v3.py` | The base-rate experiment — three prompt variants on a balanced sample. |
| `halfvec.py` | Measures `halfvec` (float16) impact on search ranking. Evidence for HOME-311. |
| `token_cost.py` | Real token counts and API cost for the "just use an LLM" baseline. |

**Do not use the regex in `project_multi.py` for anything that matters.** It is
92.6% precise but **21.8% recall** — it finds a fifth of tool output. It exists
only because it predates the classifier. Use `author_clf.joblib`.

## Three things that are load-bearing

**UMAP projections do not compose.** The manifold is fitted to whichever points
are present, so you cannot project everything once and filter client-side — you
get the contaminated geometry with some dots hidden. Each checkbox combination
needs its own fit. This is why there are five artefacts rather than one.

**Author classification here is a stopgap.** `TOOL_RE` catches *structured* tool
output, but prose-shaped output (file contents, command stdout) is
indistinguishable from Martin pasting the same thing deliberately. It finds
~9,800 tool messages where the user:assistant role ratio implies ~23,000. The
real fix is classifying at capture from transcript content-block types
(HOME-310); this exists only until that lands.

**Pin the seed.** UMAP is stochastic. Without a fixed seed the map reshuffles
between runs and you cannot reproduce a layout or reason about what changed.

## Classifying authors: what actually worked

Task: is a `role='user'` message something Martin typed, or output from a tool?
Measured on transcript ground truth, balanced accuracy so class imbalance
cannot flatter anything (86% of user-role rows are tool output).

| Approach | Accuracy | **Balanced** | Time | Cost |
|---|---|---|---|---|
| Frontier API ($3/$15 per Mtok) | not measured | — | hours | **£36–54** |
| `llama3.2:3b`, zero-shot | 88.6% | **49.4%** | 2.5 h | £0 |
| `llama3.2:3b`, few-shot | — | 65.2% | 2.5 h | £0 |
| `llama3.2:3b`, few-shot + balanced prior | — | 75.2% | 2.5 h | £0 |
| **Always answer "TOOL"** | **90.3%** | 50.0% | 0 s | £0 |
| **Embeddings + logistic regression** | **93.6%** | **93.3%** | **ms** | **£0** |

The zero-shot LLM scored **worse than a constant function**. Its confusion
matrix had no correct-human cell at all: 0 of 28. The accuracy figure was
entirely class imbalance.

Two things worth carrying forward:

**Stating a false balanced prior beat stating the true one** (75.2% vs 69.5%).
The model's problem was never calibration — its prior toward TOOL was already
too strong, so the accurate base rate just licensed the bias.

**You can weight classes in a model; you can only ask an LLM nicely.** The
logistic regression uses `class_weight="balanced"` — the same correction as
arithmetic rather than as a request. The zero-shot prompt explicitly said
"long or technical does not mean TOOL" and was ignored completely.

The semantics come from mxbai-embed-large, run months ago as ordinary ingest.
The classifier is a 5 KB boundary through that space. Borrowed understanding,
owned judgement.

## Measurements worth not re-deriving

Full numbers and context are on the Taiga stories; the headlines:

- All-pairs cosine is **not** a k-NN search, so no vector index serves it.
  Postgres self-join measured ~28.5 µs/pair (~36 MFLOP/s) — TOAST-dominated,
  since a `vector(1024)` is 4,104 bytes and lives out-of-line. As a tiled GEMM
  it is ~105 GFLOP/s on Cal, ~500 GFLOP/s on an M5 Pro. Roughly 3,000×.
- `halfvec` costs nothing measurable: top-1 identical, max cosine delta
  6.6 × 10⁻⁵, storage halved.
- `min_cluster_size` should scale with N. At 20 on Martin-only, 342 clusters and
  no blob; at 100 on the full corpus, two blobs holding 67%.
- **`max_cluster_size` beats `cluster_selection_method='leaf'`**, which is the
  documented remedy for one giant cluster and was expected to win. On 45,183
  martin+claude points, scoring by share of points in a cluster of 15–2000:

  | config | clusters | noise | largest | % useful |
  |---|---|---|---|---|
  | `eom mcs=20` | 240 | 25.3% | 16,959 | 37.1% |
  | `leaf mcs=20` | 334 | 59.2% | 318 | 40.8% |
  | **`eom mcs=20 max=2000`** | 294 | 50.6% | **1,011** | **49.4%** |

  The blob is not a property of the corpus. Excess-of-mass selection keeps the
  *most stable* clusters, and a broad featureless region is stable precisely
  because it has no internal structure to split along. Capping the size forces
  HDBSCAN further down the condensed tree. Noise roughly doubles, honestly:
  those points do not become good clusters, they become scatter, which is what
  they always were.
- **Do not read a low cluster count as a fact about the data.** The `claude`
  projection produced 3 clusters over 23,412 messages, which was written up as
  a finding — that Claude's own messages are semantically homogeneous. It was
  the same eom artefact; under the cap it is 106 clusters and nothing about the
  messages changed.
- **int8 quantisation of embeddings is free; PCA is where the loss is.** At every
  dimension, float32 and int8 score identically, so a wider dtype buys nothing.
- **Recall@k is the wrong metric for these vectors.** The *uncompressed*
  embeddings, quantised and otherwise untouched, score only 89% recall@4 at a
  mean cosine error of 0.0026 — three thousandths of a cosine reorders the top
  four. The neighbours are near-ties, so recall measures tie-breaking rather
  than retrieval. Real query, top eight: 0.852, 0.818, 0.817, 0.814, 0.811,
  0.800. Measure **quality** instead — the true cosine of what was returned
  against the true best — which is 97.6% at 128 dimensions.
- **A single-node neighbour query is affordable at any corpus size; all-pairs is
  not.** O(n·d) is 12–15 ms over 34k nodes in a browser; O(n²·d) on the
  16,890-point cluster is 36 billion operations.

## Known trap

Don't name a script after a common package. An earlier `coverage.py` in this
directory shadowed the real `coverage` when numba imported it, and the run died
with `AttributeError: module 'coverage' has no attribute 'types'`.
