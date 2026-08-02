#!/usr/bin/env python3
"""Project a pgvector corpus to 3D for the semantic graph viewer (HOME-307).

Pipeline: pull embeddings -> PCA to ~50 dims -> UMAP to 3 -> HDBSCAN clusters
-> tiled GEMM for the similarity edge list -> JSON.

Emits coordinates, never embeddings: 69,720 x 1024 f32 is ~286 MB, against
~840 KB of coordinates, and the viewer has no use for the vectors.

UMAP is stochastic, so the seed is pinned and recorded in the output.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import psycopg
from sklearn.decomposition import PCA


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch(dsn, table, id_col, text_col, limit):
    """Pull ids and embeddings. Text is fetched for labelling only and is
    never written to the artefact by this script."""
    sql = (
        f"SELECT {id_col}::text, {text_col}, embedding "
        f"FROM {table} WHERE embedding IS NOT NULL"
    )
    if limit:
        sql += f" LIMIT {limit}"

    log(f"connecting: {dsn.split('@')[-1]}")
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()

    log(f"fetched {len(rows):,} rows")
    ids = [r[0] for r in rows]
    texts = [r[1] or "" for r in rows]
    # pgvector returns the vector as its text repr '[1,2,3]' over the wire
    # unless the binary adapter is registered; parse defensively either way.
    vecs = np.array(
        [r[2] if isinstance(r[2], (list, np.ndarray)) else json.loads(r[2]) for r in rows],
        dtype=np.float32,
    )
    log(f"embedding matrix: {vecs.shape} ({vecs.nbytes / 1e6:.0f} MB)")
    return ids, texts, vecs


def edges_gemm(X, threshold, mode="knn", k=10, tile=1024):
    """All-pairs cosine, tiled so the N^2 matrix never exists.

    X must be L2-normalised, so cosine similarity is a plain dot product and
    the whole all-pairs matrix is X @ X.T. Tiling is mandatory, not an
    optimisation: at 69,720 rows the full f32 matrix is 19 GB.

    Two edge selection modes:

    `threshold` keeps every pair above a cutoff. Edge count then grows as
    N^2 -- at 2,000 rows that was 0.29% of pairs (5,882 edges), which at
    69,720 rows extrapolates to ~7M edges. Unusable, and raising the cutoff
    to compensate silently disconnects sparse regions while dense ones stay
    a hairball.

    `knn` keeps each node's top-k, so edge count is linear in N and every
    node stays connected whatever the local density. This is what a force
    graph actually wants. Default.
    """
    n = X.shape[0]
    pairs = {}
    t0 = time.perf_counter()

    for i in range(0, n, tile):
        S = X[i : i + tile] @ X.T
        # A row's best match is always itself; exclude it.
        for r in range(S.shape[0]):
            S[r, i + r] = -1.0

        if mode == "knn":
            kk = min(k, n - 1)
            idx = np.argpartition(-S, kk - 1, axis=1)[:, :kk]
            for r in range(S.shape[0]):
                a = i + r
                for c in idx[r]:
                    s = float(S[r, c])
                    if s < threshold:
                        continue
                    # Normalise ordering so a mutual pair is stored once.
                    key = (a, int(c)) if a < c else (int(c), a)
                    if key not in pairs or s > pairs[key]:
                        pairs[key] = s
        else:
            rows, cols = np.nonzero(S > threshold)
            keep = (rows + i) < cols
            for r, c in zip(rows[keep], cols[keep]):
                pairs[(int(r + i), int(c))] = float(S[r, c])

    dt = time.perf_counter() - t0
    gf = (2.0 * n * n * X.shape[1]) / dt / 1e9
    out = [(a, b, s) for (a, b), s in pairs.items()]
    log(
        f"edges: {len(out):,} ({mode}, k={k}, floor={threshold}) "
        f"in {dt:.2f}s ({gf:.0f} GFLOP/s)"
    )
    return out, False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", default=os.environ.get("DSN"))
    p.add_argument("--table", default="messages")
    p.add_argument("--id-col", default="id")
    p.add_argument("--text-col", default="content")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--pca-dims", type=int, default=50)
    p.add_argument("--threshold", type=float, default=0.85)
    p.add_argument("--edge-mode", choices=["knn", "threshold"], default="knn")
    p.add_argument("--knn-k", type=int, default=10)
    p.add_argument("--min-cluster-size", type=int, default=20)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--out", default="projection.json")
    args = p.parse_args()

    if not args.dsn:
        sys.exit("need --dsn or DSN env var")

    ids, texts, vecs = fetch(
        args.dsn, args.table, args.id_col, args.text_col, args.limit
    )
    n = len(ids)
    if n < 50:
        log(f"WARNING: {n} rows is too few for UMAP to be meaningful")

    # Normalise once. Everything downstream assumes unit vectors.
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    Xn = vecs / norms

    log(f"PCA -> {args.pca_dims} dims")
    t0 = time.perf_counter()
    n_comp = min(args.pca_dims, n, vecs.shape[1])
    Xp = PCA(n_components=n_comp, random_state=args.seed).fit_transform(Xn)
    log(f"  done in {time.perf_counter() - t0:.1f}s")

    log("UMAP -> 3 dims")
    import umap  # imported late; it is slow to load

    t0 = time.perf_counter()
    n_neighbors = min(15, max(2, n - 1))
    coords = umap.UMAP(
        n_components=3,
        n_neighbors=n_neighbors,
        min_dist=0.05,
        metric="cosine",
        random_state=args.seed,
    ).fit_transform(Xp)
    log(f"  done in {time.perf_counter() - t0:.1f}s")

    log("HDBSCAN clustering")
    # sklearn's own HDBSCAN (>=1.3) rather than the standalone package, which
    # drags in numba/llvmlite and often has no wheel for the current Python.
    from sklearn.cluster import HDBSCAN

    t0 = time.perf_counter()
    labels = HDBSCAN(min_cluster_size=args.min_cluster_size).fit_predict(coords)
    n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
    n_noise = int((labels == -1).sum())
    log(
        f"  {n_clusters} clusters, {n_noise:,} noise "
        f"({100 * n_noise / n:.1f}%) in {time.perf_counter() - t0:.1f}s"
    )

    edges, truncated = edges_gemm(
        Xn, args.threshold, mode=args.edge_mode, k=args.knn_k
    )

    # Cluster sizes. The minimum-size floor is enforced by HDBSCAN here, but
    # HOME-308 must re-check it before generating labels - a "summary" of a
    # tiny cluster is a paraphrase of its members.
    sizes = {int(c): int((labels == c).sum()) for c in set(labels) if c != -1}

    doc = {
        "meta": {
            "corpus": args.table,
            "rows": n,
            "seed": args.seed,
            "pca_dims": n_comp,
            "umap_n_neighbors": n_neighbors,
            "threshold": args.threshold,
            "edge_mode": args.edge_mode,
            "knn_k": args.knn_k,
            "min_cluster_size": args.min_cluster_size,
            "edges_truncated": truncated,
        },
        "nodes": [
            {
                "i": i,
                "id": ids[i],
                "x": round(float(coords[i][0]), 4),
                "y": round(float(coords[i][1]), 4),
                "z": round(float(coords[i][2]), 4),
                "c": int(labels[i]),
            }
            for i in range(n)
        ],
        "edges": [{"a": a, "b": b, "s": round(s, 4)} for a, b, s in edges],
        "clusters": [
            {"id": c, "size": s, "label": None} for c, s in sorted(sizes.items())
        ],
    }

    with open(args.out, "w") as f:
        json.dump(doc, f)
    log(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")

    # Cluster-size distribution is the thing to eyeball: one giant cluster or
    # a thousand tiny ones both mean the parameters need work.
    if sizes:
        ss = sorted(sizes.values(), reverse=True)
        log(f"cluster sizes: max={ss[0]} median={ss[len(ss)//2]} min={ss[-1]}")


if __name__ == "__main__":
    main()
