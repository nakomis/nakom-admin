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

## Known trap

Don't name a script after a common package. An earlier `coverage.py` in this
directory shadowed the real `coverage` when numba imported it, and the run died
with `AttributeError: module 'coverage' has no attribute 'types'`.
