"""Train an author classifier on transcript-labelled embeddings (HOME-311).

Ground truth covers 27% of the corpus. Rather than extrapolate a 22%-recall
regex over the rest, train on the labelled portion using the embeddings that
already exist and apply that to the unlabelled 73%.
"""
import json
import numpy as np, psycopg
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix

gt = json.load(open("ground_truth.json"))
with psycopg.connect("postgres://claude:claude@172.29.0.30:5432/claude_chats") as c, c.cursor() as cur:
    cur.execute("SELECT message_uuid, role, embedding::text FROM messages WHERE embedding IS NOT NULL")
    rows = cur.fetchall()

lab, vecs, roles = [], [], []
for u, role, e in rows:
    if u in gt:
        a = gt[u]
        lab.append("tool" if a in ("tool", "harness") else a)
        vecs.append(json.loads(e)); roles.append(role)
X = np.array(vecs, dtype=np.float32); y = np.array(lab)
X /= np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)
print(f"labelled: {len(y):,}  {dict(zip(*np.unique(y, return_counts=True)))}")

# role is a free, near-perfect feature for 'claude'; the hard call is
# tool-vs-martin *within* role='user'. Train only on that.
m = np.array(roles) == "user"
Xu, yu = X[m], y[m]
print(f"user-role subset: {len(yu):,}  {dict(zip(*np.unique(yu, return_counts=True)))}\n")

Xtr, Xte, ytr, yte = train_test_split(Xu, yu, test_size=0.25, random_state=42, stratify=yu)
clf = LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")
clf.fit(Xtr, ytr)
pred = clf.predict(Xte)
print(classification_report(yte, pred, digits=3))
print("confusion (rows=true martin,tool):")
print(confusion_matrix(yte, pred, labels=["martin", "tool"]))

import joblib, os
joblib.dump(clf, "author_clf.joblib")
print(f"\nsaved author_clf.joblib ({os.path.getsize('author_clf.joblib')/1024:.0f} KB)")
