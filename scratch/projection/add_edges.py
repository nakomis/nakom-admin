#!/usr/bin/env python3
"""Add intra-cluster kNN edges to existing projections (ADMIN-11).

The viewer's global view deliberately has no edges — UMAP already encodes
similarity as position, and a full edge list took each artefact from ~2.5 MB to
~13 MB. But the admin console's d3 graph could show *which specific pair* is
similar, not merely that a region is dense, and for spam-cluster detection the
individual link is the point.

So edges are precomputed per cluster and drawn only for a selected one.

Real cosine, not 3D proximity. The bundle carries no embeddings (286 MB of
them, and the viewer has no other use), so the browser cannot compute
similarity itself. Deriving edges from the projected coordinates instead would
be circular — it would draw lines asserting "these are similar" using only the
positions that already assert it, and would inherit every distortion UMAP
introduced. Computing them here, against the vectors, keeps the edge a genuine
claim about the messages.

Only *within* a cluster: cross-cluster edges are what made the full list
enormous, and the selected-cluster interaction never shows them.
"""
import argparse
import json
import pathlib
import sys
import time

import numpy as np
import psycopg


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def knn_within(X, k, floor):
    """Top-k neighbours per row by cosine, as deduplicated (i, j, sim).

    X must be L2-normalised. Clusters are small enough that the full k x k
    product is cheaper than any indexing structure.
    """
    n = len(X)
    if n < 2:
        return []
    S = X @ X.T
    np.fill_diagonal(S, -1.0)
    kk = min(k, n - 1)
    idx = np.argpartition(-S, kk - 1, axis=1)[:, :kk]

    pairs = {}
    for i in range(n):
        for j in idx[i]:
            s = float(S[i, j])
            if s < floor:
                continue
            key = (i, int(j)) if i < j else (int(j), i)
            if key not in pairs or s > pairs[key]:
                pairs[key] = s
    return [(a, b, s) for (a, b), s in pairs.items()]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", required=True)
    p.add_argument("--dir", default=".")
    p.add_argument("--prefix", default="projv2")
    p.add_argument("--k", type=int, default=4)
    p.add_argument("--floor", type=float, default=0.55)
    a = p.parse_args()

    src = pathlib.Path(a.dir)
    files = sorted(src.glob(f"{a.prefix}-*.json"))
    files = [f for f in files if not f.name.endswith("-manifest.json")]
    if not files:
        sys.exit(f"no {a.prefix}-*.json under {src}")

    # One fetch for every projection: the pull is the slow stage (~80 s,
    # dominated by pgvector's text wire format), and the projections are
    # overlapping subsets of the same corpus.
    t0 = time.perf_counter()
    with psycopg.connect(a.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id::text, embedding::text FROM messages WHERE embedding IS NOT NULL")
        rows = cur.fetchall()
    log(f"fetched {len(rows):,} embeddings in {time.perf_counter() - t0:.0f}s")

    by_id = {r[0]: i for i, r in enumerate(rows)}
    X = np.array([json.loads(r[1]) for r in rows], dtype=np.float32)
    X /= np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)

    for f in files:
        doc = json.loads(f.read_text())
        nodes = doc.get("nodes") or []
        if not nodes:
            continue

        # Group node positions by cluster, keeping the index *into this
        # projection's node array* — that is what the viewer indexes by.
        groups = {}
        for local, node in enumerate(nodes):
            groups.setdefault(node["c"], []).append(local)

        edges = []
        skipped = 0
        t = time.perf_counter()
        for cid, locals_ in groups.items():
            rowidx = [by_id.get(nodes[l]["id"]) for l in locals_]
            keep = [(l, r) for l, r in zip(locals_, rowidx) if r is not None]
            skipped += len(locals_) - len(keep)
            if len(keep) < 2:
                continue
            sub = X[[r for _, r in keep]]
            for i, j, s in knn_within(sub, a.k, a.floor):
                edges.append((keep[i][0], keep[j][0], round(s, 3)))

        doc["edges"] = edges
        doc["edge_params"] = {"k": a.k, "floor": a.floor, "scope": "intra-cluster"}
        f.write_text(json.dumps(doc))
        log(f"{f.name:<28} {len(groups):>4} clusters  {len(edges):>7,} edges  "
            f"({time.perf_counter() - t:.0f}s)"
            + (f"  [{skipped} nodes had no embedding]" if skipped else ""))


if __name__ == "__main__":
    main()
