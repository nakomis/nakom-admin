#!/usr/bin/env python3
"""Per-author-combination 3D projections for the semantic graph viewer.

The viewer has Claude / Martin / Tools checkboxes. UMAP projections do NOT
compose: the manifold is fitted to whichever points are present, so filtering
a single all-messages projection client-side would show the *contaminated*
geometry with some dots hidden. Each combination therefore needs its own fit.

Embeddings are fetched once and subset in memory -- the fetch is the slowest
stage (~90s, dominated by pgvector's text wire format), so doing it per
combination would be five times the wait for no benefit.

No edges are emitted. UMAP already encodes similarity as position, which is
what the algorithm is for; edges largely redraw what proximity shows and at
40k+ nodes render as fog. Dropping them takes each artefact from ~13 MB to
~1.5 MB. Per-cluster edges on demand are a viewer concern, not a batch one.

Scatter (HDBSCAN noise) is dropped from the output.
"""
import argparse
import json
import re
import time
import warnings

import numpy as np
import psycopg
from sklearn.cluster import HDBSCAN
from sklearn.decomposition import PCA

warnings.filterwarnings("ignore")


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


# Tool/harness output that currently lands in role='user'. This is a stopgap:
# the real fix is classifying at capture, where the transcript still has
# structured content blocks and a tool_result is unambiguous (HOME-309/310).
# Prose-shaped tool output (file contents, command stdout) is NOT caught here
# and will still be attributed to Martin.
TOOL_RE = re.compile(
    r"^\s*[\[{]"
    r"|<system-reminder>"
    r"|<function_results>"
    r"|<command-name>"
    r"|<local-command"
    r"|tool_use_error"
    r"|^Caveat:"
    r"|^Web search results for query:"
    r"|Request interrupted"
    r"|doesn't want to proceed with this tool use"
    r"|^Result of calling"
    r"|^Shell cwd was reset to",
    re.IGNORECASE,
)


def classify(role, content):
    """Regex fallback. Only used when author_clf.joblib is absent.

    92.6% precision but 21.8% recall — it finds a fifth of tool output. Kept
    so the script still runs standalone, not because it is good enough.
    """
    if role == "assistant":
        return "claude"
    if len(content) < 12 or TOOL_RE.search(content):
        return "tool"
    return "martin"


def classify_all(rows, X, martin_threshold):
    """Classifier if available, regex otherwise.

    `role='assistant'` is authoritative for Claude — no model needed. The only
    hard call is tool-vs-martin *within* role='user', which is what the
    classifier was trained on.

    The threshold trades recall for precision on the martin bucket. At 0.5:
    93% recall, 71% precision. At 0.8: 72% recall, 92% precision. For a view
    labelled "messages I wrote", a clean bucket matters more than a complete
    one — a quarter of Martin's messages missing is invisible, while a third
    of the bucket being command output is not.
    """
    try:
        import joblib
        clf = joblib.load("author_clf.joblib")
    except Exception as e:
        log(f"no classifier ({e}) — falling back to regex, 21.8% recall")
        return np.array([classify(r[1], r[2]) for r in rows])

    authors = np.empty(len(rows), dtype=object)
    is_user = np.array([r[1] == "user" for r in rows])
    authors[~is_user] = "claude"

    mi = list(clf.classes_).index("martin")
    Xn = X[is_user] / np.maximum(
        np.linalg.norm(X[is_user], axis=1, keepdims=True), 1e-12)
    prob = clf.predict_proba(Xn)[:, mi]

    # Deliberately NOT unioned with TOOL_RE, though it looks like it should be.
    # Measured on held-out ground truth at t=0.8, the union moves martin
    # precision 92.5% -> 94.0% but recall 70.0% -> 62.0%; balanced accuracy
    # falls 84.5% -> 80.7%.
    #
    # The reason is a base-rate trap. TOOL_RE's 92.6% precision was measured on
    # the whole user-role population, which is ~86% tool. Applied to the subset
    # the classifier already believes is Martin — ~92% Martin — its positives
    # are mostly Martin deliberately pasting JSON, commit output or config,
    # which he does constantly. Precision does not transfer across populations.
    authors[np.flatnonzero(is_user)] = np.where(
        prob >= martin_threshold, "martin", "tool")
    log(f"classifier: threshold={martin_threshold} on {is_user.sum():,} user-role rows")
    return authors


def project(X, seed, min_cluster_size, pca_dims, max_cluster_size=None):
    """Normalise -> PCA -> UMAP(3) -> HDBSCAN. Returns (coords, labels)."""
    import umap

    Xn = X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)
    n_comp = min(pca_dims, Xn.shape[0], Xn.shape[1])
    Xp = PCA(n_components=n_comp, random_state=seed).fit_transform(Xn)

    coords = umap.UMAP(
        n_components=3,
        n_neighbors=min(15, max(2, len(Xp) - 1)),
        min_dist=0.05,
        metric="cosine",
        random_state=seed,
    ).fit_transform(Xp)

    # max_cluster_size caps how large a cluster HDBSCAN will accept, forcing it
    # further down the condensed tree wherever one would exceed the cap.
    #
    # Without it the martin-claude fit produced a single 16,890-point cluster —
    # 37% of the corpus in one blob that no label described. That is not a bug
    # in the data, it is what the default 'excess of mass' selection optimises
    # for: it keeps the *most stable* clusters, and a broad featureless bulk is
    # stable precisely because it has no internal structure to split along.
    #
    # Measured against cluster_selection_method='leaf', the usual remedy, on
    # 45,183 martin+claude points (% of points landing in a cluster of 15-2000,
    # i.e. big enough to be a topic and small enough to label):
    #
    #   eom  mcs=20 (was)   240 clusters  25.3% noise  largest 16,959  37.1% useful
    #   leaf mcs=20         334 clusters  59.2% noise  largest    318  40.8% useful
    #   eom  mcs=20 max=2000 294 clusters 50.6% noise  largest  1,011  49.4% useful
    #
    # The cap wins on every axis against leaf, which was the surprise. What it
    # costs is honest rather than hidden: noise doubles, because the blob's
    # points do not become good clusters — they become scatter, which is what
    # they always were.
    kw = {"min_cluster_size": min_cluster_size}
    if max_cluster_size:
        kw["max_cluster_size"] = max_cluster_size
    labels = HDBSCAN(**kw).fit_predict(coords)
    return coords, labels


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", required=True)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--pca-dims", type=int, default=50)
    p.add_argument("--min-cluster-size", type=int, default=20)
    p.add_argument("--max-cluster-size", type=int, default=2000,
                   help="cap on cluster size; forces HDBSCAN further down the "
                        "condensed tree rather than accepting one featureless "
                        "blob. 0 disables. See project() for the measurements.")
    p.add_argument("--out-prefix", default="proj")
    p.add_argument("--martin-threshold", type=float, default=0.8,
                   help="classifier probability above which a user-role "
                        "message counts as Martin. Higher = cleaner bucket, "
                        "fewer messages.")
    args = p.parse_args()

    t0 = time.perf_counter()
    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id::text, role, content, embedding::text "
            "FROM messages WHERE embedding IS NOT NULL"
        )
        rows = cur.fetchall()
    log(f"fetched {len(rows):,} rows in {time.perf_counter() - t0:.0f}s")

    ids = [r[0] for r in rows]
    X = np.array([json.loads(r[3]) for r in rows], dtype=np.float32)
    authors = classify_all(rows, X, args.martin_threshold)

    counts = {a: int((authors == a).sum()) for a in ("martin", "claude", "tool")}
    log(f"authors: {counts}")

    combos = [
        ("martin", ("martin",)),
        ("claude", ("claude",)),
        ("tool", ("tool",)),
        ("martin-claude", ("martin", "claude")),
        ("all", ("martin", "claude", "tool")),
    ]

    manifest = {"seed": args.seed, "authors": counts, "projections": []}

    for name, members in combos:
        mask = np.isin(authors, members)
        sub = X[mask]
        sub_ids = [ids[i] for i in np.flatnonzero(mask)]
        sub_auth = authors[mask]

        log(f"--- {name}: {len(sub):,} nodes ---")
        t = time.perf_counter()
        coords, labels = project(sub, args.seed, args.min_cluster_size,
                                 args.pca_dims, args.max_cluster_size or None)
        keep = labels != -1
        sizes = {int(c): int((labels == c).sum()) for c in set(labels) if c != -1}

        doc = {
            "name": name,
            "authors": list(members),
            "seed": args.seed,
            "min_cluster_size": args.min_cluster_size,
            "max_cluster_size": args.max_cluster_size or None,
            "total": int(len(sub)),
            "kept": int(keep.sum()),
            "dropped_scatter": int((~keep).sum()),
            # Author is per-node so the viewer can colour or re-filter within
            # a projection without needing a different fit.
            "nodes": [
                {
                    "x": round(float(coords[i][0]), 3),
                    "y": round(float(coords[i][1]), 3),
                    "z": round(float(coords[i][2]), 3),
                    "c": int(labels[i]),
                    "a": sub_auth[i][0],  # 'm' | 'c' | 't'
                    "id": sub_ids[i],
                }
                for i in np.flatnonzero(keep)
            ],
            "clusters": [
                {"id": c, "size": s, "label": None} for c, s in sorted(sizes.items())
            ],
        }
        path = f"{args.out_prefix}-{name}.json"
        with open(path, "w") as f:
            json.dump(doc, f)

        import os

        mb = os.path.getsize(path) / 1e6
        log(
            f"    {len(sizes)} clusters, kept {keep.sum():,}/{len(sub):,} "
            f"({100 * keep.sum() / len(sub):.0f}%), {mb:.1f} MB, "
            f"{time.perf_counter() - t:.0f}s"
        )
        manifest["projections"].append(
            {
                "name": name,
                "file": path,
                "nodes": int(keep.sum()),
                "clusters": len(sizes),
                "mb": round(mb, 2),
            }
        )

    with open(f"{args.out_prefix}-manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)
    total = sum(p["mb"] for p in manifest["projections"])
    log(f"done. {len(combos)} projections, {total:.1f} MB total")


if __name__ == "__main__":
    main()
