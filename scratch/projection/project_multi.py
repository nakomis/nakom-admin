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
    if role == "assistant":
        return "claude"
    if len(content) < 12 or TOOL_RE.search(content):
        return "tool"
    return "martin"


def project(X, seed, min_cluster_size, pca_dims):
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

    labels = HDBSCAN(min_cluster_size=min_cluster_size).fit_predict(coords)
    return coords, labels


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", required=True)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--pca-dims", type=int, default=50)
    p.add_argument("--min-cluster-size", type=int, default=20)
    p.add_argument("--out-prefix", default="proj")
    args = p.parse_args()

    t0 = time.perf_counter()
    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id::text, role, content, embedding::text "
            "FROM messages WHERE embedding IS NOT NULL"
        )
        rows = cur.fetchall()
    log(f"fetched {len(rows):,} rows in {time.perf_counter() - t0:.0f}s")

    authors = np.array([classify(r[1], r[2]) for r in rows])
    ids = [r[0] for r in rows]
    X = np.array([json.loads(r[3]) for r in rows], dtype=np.float32)

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
        coords, labels = project(sub, args.seed, args.min_cluster_size, args.pca_dims)
        keep = labels != -1
        sizes = {int(c): int((labels == c).sum()) for c in set(labels) if c != -1}

        doc = {
            "name": name,
            "authors": list(members),
            "seed": args.seed,
            "min_cluster_size": args.min_cluster_size,
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
