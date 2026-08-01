#!/usr/bin/env python3
"""Pack compressed embeddings into the bundle so the browser can compute
similarity itself (ADMIN-11 experiment).

Today's edges are frozen: add_edges.py picks k=4 at a cosine floor of 0.55 and
bakes the result in. You cannot ask "show me only links above 0.8" without
re-running the batch job, and you cannot ask "what is this one message closest
to" at all. Both are natural questions and both need the vectors client-side.

The vectors as stored are 1024-dimensional float32 — 286 MB for 70k messages,
which is not a web page. This script compresses them along two axes at once:

  PCA to D dimensions, then int8 quantisation.

PCA first because the embedding space is nowhere near full rank: mxbai spends
most of its 1024 dimensions on distinctions this corpus never makes. Dropping
to 64 keeps the variance that actually separates these messages. int8 second
because after L2 normalisation every component is small and bounded, so a byte
per component is ample — and the browser can do the dot product in an Int8Array
without unpacking.

Whether that is *true* is the point of --report, which is not decoration: it
measures the compressed vectors against the originals rather than assuming the
compression was harmless. Two numbers matter, and they measure different
failures:

  - cosine error: does a similarity score survive compression?
  - neighbour recall: do the same messages still come out on top?

Measured, both of those turned out to be answering the wrong question, and the
result is worth writing down because it is not the intuitive one:

  config          recall@4   returned-cos   quality   >=0.55 floor
  pca64  int8       52.2%       0.6354       94.8%       62.5%
  pca128 int8       64.3%       0.6546       97.6%       67.5%
  pca256 int8       73.7%       0.6651       99.2%       70.2%
  full 1024 int8    89.1%       0.6704      100.0%       71.5%
                                (true best top-4 mean cosine: 0.6704)

Two things fall out. First, int8 is free: at every dimension the float32 and
int8 rows score the same, so the entire loss is PCA and widening the dtype
would buy nothing. Second, and the reason the recall column is a trap — the
*uncompressed* vectors, quantised and nothing else, score only 89% recall@4 at
a cosine error of 0.0026. Three thousandths of a cosine reorders the top four.
That is not a compression failure; it means the true neighbours are near-ties,
separated by less than any achievable noise floor.

So recall@4 measures tie-breaking, not retrieval quality. If neighbours four
and five sit at 0.812 and 0.811, swapping them is not an error and the edge
drawn is just as true. The column that matters is quality: the mean *true*
cosine of whatever the compressed vectors returned, against the mean true
cosine of the genuine best. At 128 dimensions that is 97.6% — the compressed
index is not finding wrong messages, it is finding equally good ones in a
different order, which is all the viewer needs to draw a link.

--report prints all of these. Read the quality column, not the recall one.
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


def l2(X):
    return X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)


def fit_basis(X, dims):
    """Fit the PCA basis once, to be applied to several projections.

    Returned as (mean, components) so the same rotation can be reused. See
    --shared-basis: the five projections overlap heavily, and a per-projection
    basis means shipping the same message's vector more than once under
    different rotations.
    """
    from sklearn.decomposition import PCA
    Xn = l2(X)
    mean = Xn.mean(axis=0, keepdims=True)
    pca = PCA(n_components=dims, svd_solver="randomized", random_state=0)
    pca.fit(Xn - mean)
    return mean, pca.components_, float(pca.explained_variance_ratio_.sum())


def apply_basis(X, mean, components):
    """Project and quantise against an already-fitted basis."""
    Y = l2((l2(X) - mean) @ components.T)
    return np.clip(np.rint(Y * 127.0), -127, 127).astype(np.int8)


def compress(X, dims):
    """L2 -> PCA(dims) -> L2 -> int8. Returns (int8 array, explained variance).

    Normalised before PCA so the components describe direction rather than
    magnitude — cosine similarity ignores magnitude, so letting a few long
    vectors dominate the principal axes would spend dimensions on something the
    metric discards.

    Normalised *again* after PCA because the projection does not preserve norm.
    Without it the quantiser would have to cope with a wide range of scales and
    the browser would have to divide by a per-row norm at query time.
    """
    Xn = l2(X)
    Xc = Xn - Xn.mean(axis=0, keepdims=True)
    # Full SVD of a 35k x 1024 matrix is unnecessary: only the top `dims`
    # right-singular vectors are wanted, and randomised SVD gets them in a
    # fraction of the time at an accuracy far below the quantisation noise
    # that follows anyway.
    from sklearn.decomposition import PCA
    pca = PCA(n_components=dims, svd_solver="randomized", random_state=0)
    Y = l2(pca.fit_transform(Xc))
    # 127, not 128: the range must stay symmetric so that -1 and +1 quantise to
    # equal and opposite values. Using 128 would make the most negative
    # component overflow int8.
    q = np.clip(np.rint(Y * 127.0), -127, 127).astype(np.int8)
    return q, float(pca.explained_variance_ratio_.sum())


def report(X, q, sample, k, seed):
    """Compare compressed similarity against the originals."""
    rng = np.random.default_rng(seed)
    n = len(X)
    idx = rng.choice(n, size=min(sample, n), replace=False)

    Xn = l2(X)
    # Dequantise exactly as the browser will: integer dot product, divided by
    # the row norms. Comparing against float PCA output instead would measure
    # PCA alone and quietly skip the quantisation error.
    Q = q.astype(np.float32)
    Q = Q / np.maximum(np.linalg.norm(Q, axis=1, keepdims=True), 1e-12)

    true_S = Xn[idx] @ Xn.T
    comp_S = Q[idx] @ Q.T
    for i, r in enumerate(idx):
        true_S[i, r] = -2.0
        comp_S[i, r] = -2.0

    err = np.abs(true_S - comp_S)
    tk = np.argpartition(-true_S, k, axis=1)[:, :k]
    ck = np.argpartition(-comp_S, k, axis=1)[:, :k]

    # Recall@k: did we retrieve the same rows. Reported because it is the
    # conventional number and its absence would look like hiding something,
    # but see the module docstring — here it largely measures tie-breaking
    # among near-identical neighbours, not retrieval quality.
    recall = np.mean([len(set(a) & set(b)) / k for a, b in zip(tk, ck)])

    # Quality: the mean *true* cosine of the neighbours the compressed vectors
    # returned, over the mean true cosine of the genuine best. This is the one
    # that predicts whether a drawn link is a real claim about the messages.
    best = np.mean([true_S[i, tk[i]].mean() for i in range(len(idx))])
    got = np.mean([true_S[i, ck[i]].mean() for i in range(len(idx))])

    return {
        "sampled_rows": int(len(idx)),
        "cosine_mae": float(err.mean()),
        "cosine_p99": float(np.percentile(err, 99)),
        f"recall@{k}": float(recall),
        "returned_cosine": float(got),
        "true_best_cosine": float(best),
        "quality": float(got / best) if best else 0.0,
        # Spearman would be the textbook choice, but on 35k columns per row it
        # is far slower and Pearson on cosines is monotone enough to serve as
        # a sanity check alongside the quality figure that actually decides.
        "pearson": float(np.corrcoef(true_S.ravel(), comp_S.ravel())[0, 1]),
    }


def shared(files, X, by_id, a):
    """One basis, one table, referenced by every projection.

    The five projections are overlapping subsets of one corpus: they carry
    127,187 node slots between them for 62,768 distinct messages, so a
    per-projection basis ships most vectors twice under different rotations.
    One shared table removes that, and a projection then costs only an index
    array.

    This was expected to cost fidelity in the single-author views, on the
    reasoning that a corpus-wide basis spends components on distinctions those
    views do not contain — separating tool output inside the martin-only view,
    where there is none. Measured, it does not:

      view            shared    per-projection
      martin           98.0%        97.6%
      claude           97.5%          —
      tool             99.4%          —
      all              99.0%          —
      martin-claude    98.3%          —

    The shared basis is fitted on 62,768 messages where the martin-only basis
    saw 16,205, and the better-estimated axes more than pay for the ones that
    view wastes. So it is not a trade at all: half the bytes, marginally better
    quality. Worth stating because the opposite is the intuitive answer, and it
    was the one written here first.
    """
    import base64

    docs = {f: json.loads(f.read_text()) for f in files}

    # The basis is fitted on the distinct union, not on a concatenation of the
    # projections: repeating a message five times would weight it five times
    # and pull the principal axes towards whatever the overlapping views
    # happen to share.
    union = []
    seen = set()
    for doc in docs.values():
        for n in doc.get("nodes") or []:
            r = by_id.get(n["id"])
            if r is not None and r not in seen:
                seen.add(r)
                union.append(r)
    union.sort()
    log(f"shared basis over {len(union):,} distinct messages "
        f"(vs {sum(len(d.get('nodes') or []) for d in docs.values()):,} node slots)")

    t = time.perf_counter()
    mean, comps, evr = fit_basis(X[union], a.dims)
    q = apply_basis(X[union], mean, comps)
    log(f"fitted {a.dims}d in {time.perf_counter() - t:.0f}s  "
        f"{q.nbytes/1e6:.2f} MB  evr {evr:.1%}")

    row_of_source = {src: i for i, src in enumerate(union)}
    table = {
        "dims": a.dims,
        "count": len(union),
        "data": base64.b64encode(q.tobytes()).decode(),
        "explained_variance": round(evr, 4),
    }

    for f, doc in docs.items():
        nodes = doc.get("nodes") or []
        # -1 for a node with no embedding: the viewer must treat it as
        # unqueryable rather than as row 0, which would silently answer every
        # query about it with someone else's neighbours.
        idx = [row_of_source.get(by_id.get(n["id"], -1), -1) for n in nodes]
        doc["emb"] = {"shared": True, "dims": a.dims, "rows": idx}
        if a.report:
            have = [i for i, r in enumerate(idx) if r >= 0]
            if len(have) > a.dims:
                sub = X[[union[idx[i]] for i in have]]
                st = report(sub, q[[idx[i] for i in have]],
                            a.report_sample, a.report_k, a.seed)
                doc["emb"]["fidelity"] = st
                log(f"{f.name:<28} recall@{a.report_k} "
                    f"{st[f'recall@{a.report_k}']:.1%}  quality {st['quality']:.1%}")
        f.write_text(json.dumps(doc))

    out = files[0].parent / f"{a.prefix}-embeddings.json"
    out.write_text(json.dumps(table))
    log(f"wrote {out.name} ({out.stat().st_size/1e6:.1f} MB)")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", required=True)
    p.add_argument("--dir", default=".")
    p.add_argument("--prefix", default="projv2")
    p.add_argument("--dims", type=int, default=64)
    p.add_argument("--report", action="store_true",
                   help="measure compressed similarity against the originals")
    p.add_argument("--report-sample", type=int, default=400)
    p.add_argument("--report-k", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--shared-basis", action="store_true",
                   help="fit one PCA basis across every projection and write a "
                        "single shared table, instead of one basis each")
    a = p.parse_args()

    src = pathlib.Path(a.dir)
    files = [f for f in sorted(src.glob(f"{a.prefix}-*.json"))
             if not f.name.endswith("-manifest.json")]
    if not files:
        sys.exit(f"no {a.prefix}-*.json under {src}")

    t0 = time.perf_counter()
    with psycopg.connect(a.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id::text, embedding::text FROM messages WHERE embedding IS NOT NULL")
        rows = cur.fetchall()
    log(f"fetched {len(rows):,} embeddings in {time.perf_counter() - t0:.0f}s")

    by_id = {r[0]: i for i, r in enumerate(rows)}
    X = np.array([json.loads(r[1]) for r in rows], dtype=np.float32)

    if a.shared_basis:
        return shared(files, X, by_id, a)

    for f in files:
        doc = json.loads(f.read_text())
        nodes = doc.get("nodes") or []
        if not nodes:
            continue

        # PCA is fitted per projection, on exactly the points that projection
        # shows. A basis fitted to the whole corpus would spend components
        # separating tool output even in the martin-only view, where no tool
        # output exists — wasting the budget that view most needs.
        rowidx = [by_id.get(n["id"]) for n in nodes]
        have = [i for i, r in enumerate(rowidx) if r is not None]
        if len(have) < a.dims:
            log(f"{f.name}: only {len(have)} embeddings, skipping")
            continue
        sub = X[[rowidx[i] for i in have]]

        t = time.perf_counter()
        q, evr = compress(sub, a.dims)
        line = (f"{f.name:<28} {len(have):>6,} vecs -> {a.dims}d int8  "
                f"{q.nbytes/1e6:.2f} MB  evr {evr:.1%}  "
                f"({time.perf_counter() - t:.0f}s)")

        stats = None
        if a.report:
            stats = report(sub, q, a.report_sample, a.report_k, a.seed)
            line += (f"\n  {' ':26} mae {stats['cosine_mae']:.4f}  "
                     f"recall@{a.report_k} {stats[f'recall@{a.report_k}']:.1%}  "
                     f"quality {stats['quality']:.1%}  "
                     f"(returned {stats['returned_cosine']:.4f} vs best "
                     f"{stats['true_best_cosine']:.4f})")
        log(line)

        # Indices are into this projection's node array; a node without an
        # embedding gets none, and the viewer must treat it as unqueryable
        # rather than as a zero vector (which would be equidistant from
        # everything and quietly pollute every neighbour list).
        import base64
        doc["emb"] = {
            "dims": a.dims,
            "idx": have,
            "data": base64.b64encode(q.tobytes()).decode(),
            "explained_variance": round(evr, 4),
        }
        if stats:
            doc["emb"]["fidelity"] = stats
        f.write_text(json.dumps(doc))


if __name__ == "__main__":
    main()
