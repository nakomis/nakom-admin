"""Measure what float16 (halfvec) storage does to semantic search results."""
import json
import numpy as np, psycopg

with psycopg.connect("postgres://claude:claude@172.29.0.30:5432/claude_chats") as c, c.cursor() as cur:
    cur.execute("SELECT embedding::text FROM messages WHERE embedding IS NOT NULL LIMIT 5000")
    X = np.array([json.loads(r[0]) for r in cur.fetchall()], dtype=np.float32)

X /= np.linalg.norm(X, axis=1, keepdims=True)
H = X.astype(np.float16).astype(np.float32)          # round-trip through half
H /= np.linalg.norm(H, axis=1, keepdims=True)

print(f"corpus {X.shape}, value range [{X.min():.4f}, {X.max():.4f}]")
print(f"float16 min normal is 6.1e-5; smallest |component| here is {np.abs(X[X!=0]).min():.2e}\n")

Q = np.arange(0, len(X), 10)                          # 500 queries
Sf = X[Q] @ X.T
Sh = H[Q] @ H.T
np.fill_diagonal(Sf[:, Q[0]::1][:, :0] if False else Sf[:, :0], 0)  # no-op guard
for i, q in enumerate(Q):
    Sf[i, q] = -1; Sh[i, q] = -1

d = np.abs(Sf - Sh)
print(f"cosine delta:  mean={d.mean():.2e}  p99={np.percentile(d,99):.2e}  max={d.max():.2e}")

for k in (1, 10, 100):
    tf = np.argpartition(-Sf, k, axis=1)[:, :k]
    th = np.argpartition(-Sh, k, axis=1)[:, :k]
    overlap = np.mean([len(set(a) & set(b)) / k for a, b in zip(tf, th)])
    top1 = np.mean(tf[:, :1].ravel() == th[:, :1].ravel()) if k == 1 else None
    extra = f"   (exact top-1 match: {100*top1:.1f}%)" if top1 is not None else ""
    print(f"recall@{k:<3} overlap: {100*overlap:.3f}%{extra}")

print(f"\nstorage: vector={X.nbytes/1e6:.1f} MB  halfvec={X.nbytes/2e6:.1f} MB  for {len(X):,} rows")
