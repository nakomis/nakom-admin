#!/usr/bin/env python3
"""LLM adjudication of the classifier's uncertainty band (HOME-311).

The embedding classifier is 98.5% accurate outside p in [0.2, 0.8] and 75.6%
inside it. Rather than send the whole corpus to an LLM, send only the band --
about 18% of messages -- and keep the cheap model's verdict elsewhere.

Two modes:

  --benchmark N   classify N transcript-labelled messages and report accuracy
                  against ground truth. This is what fills in "how good would
                  just using an LLM have been?"

  --run           adjudicate the real uncertainty band, writing results
                  incrementally so an overnight run survives interruption and
                  resumes where it stopped.
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.request

import numpy as np
import psycopg

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MAX_CHARS = 700

PROMPT = """Classify this message from a developer's AI-assistant transcript.

MARTIN = typed by the human. Questions, instructions, opinions, corrections,
or content they deliberately pasted to discuss.
TOOL = emitted by a program. Command output, file contents, API responses,
search results, diffs, logs, error traces, status dumps.

Long or technical does not mean TOOL: humans paste code to ask about it.
The question is whether a person composed it or a machine emitted it.

Message:
---
{text}
---

Answer with exactly one word: MARTIN or TOOL"""


def ask(model, text, timeout=120):
    body = json.dumps({
        "model": model,
        "prompt": PROMPT.format(text=text[:MAX_CHARS]),
        "stream": False,
        "options": {"temperature": 0, "num_predict": 5},
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate", data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())["response"].strip().upper()
    if "MARTIN" in out:
        return "martin"
    if "TOOL" in out:
        return "tool"
    return None


def fetch(dsn, where, params=None):
    with psycopg.connect(dsn) as c, c.cursor() as cur:
        cur.execute(
            f"SELECT message_uuid, content, embedding::text FROM messages "
            f"WHERE embedding IS NOT NULL AND {where}", params or ())
        return cur.fetchall()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", required=True)
    p.add_argument("--model", default="llama3.2:3b")
    p.add_argument("--benchmark", type=int, default=0)
    p.add_argument("--run", action="store_true")
    p.add_argument("--out", default="llm_labels.jsonl")
    a = p.parse_args()

    if a.benchmark:
        gt = json.load(open("ground_truth.json"))
        rows = [r for r in fetch(a.dsn, "role='user'") if r[0] in gt]
        rng = np.random.default_rng(42)
        pick = rng.choice(len(rows), size=min(a.benchmark, len(rows)), replace=False)
        ok = n = 0
        conf = {}
        t0 = time.perf_counter()
        for j, i in enumerate(pick, 1):
            u, text, _ = rows[i]
            truth = "tool" if gt[u] in ("tool", "harness") else "martin"
            try:
                pred = ask(a.model, text)
            except (urllib.error.URLError, TimeoutError):
                pred = None
            if pred is None:
                continue
            n += 1
            ok += pred == truth
            conf[(truth, pred)] = conf.get((truth, pred), 0) + 1
            if j % 25 == 0:
                el = time.perf_counter() - t0
                print(f"  {j}/{len(pick)}  acc={100*ok/max(n,1):.1f}%  "
                      f"{el/j:.2f}s/msg", flush=True)
        el = time.perf_counter() - t0
        print(f"\nmodel: {a.model}   n={n}")
        print(f"accuracy: {100*ok/max(n,1):.1f}%")
        print(f"speed:    {el/max(len(pick),1):.2f} s/msg  "
              f"-> {46691*el/max(len(pick),1)/3600:.1f} h for 46,691 user messages")
        print("confusion (true -> pred):")
        for k, v in sorted(conf.items()):
            print(f"  {k[0]:>6} -> {k[1]:<6} {v}")
        return

    if not a.run:
        p.error("pass --benchmark N or --run")

    # Adjudicate the real uncertainty band.
    import joblib
    clf = joblib.load("author_clf.joblib")
    mi = list(clf.classes_).index("martin")

    rows = fetch(a.dsn, "role='user'")
    X = np.array([json.loads(r[2]) for r in rows], dtype=np.float32)
    X /= np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)
    prob = clf.predict_proba(X)[:, mi]
    band = [(rows[i][0], rows[i][1], float(prob[i]))
            for i in np.flatnonzero((prob >= 0.2) & (prob <= 0.8))]

    done = set()
    if os.path.exists(a.out):
        for line in open(a.out):
            try:
                done.add(json.loads(line)["uuid"])
            except Exception:
                pass
    todo = [b for b in band if b[0] not in done]
    print(f"band={len(band):,}  already done={len(done):,}  todo={len(todo):,}",
          flush=True)

    t0 = time.perf_counter()
    fails = 0
    with open(a.out, "a") as f:
        for i, (u, text, pr) in enumerate(todo, 1):
            try:
                pred = ask(a.model, text)
                fails = 0
            except Exception as e:
                fails += 1
                print(f"  error ({fails}): {e}", flush=True)
                if fails >= 10:
                    print("  10 consecutive failures - stopping", flush=True)
                    break
                time.sleep(5)
                continue
            f.write(json.dumps({"uuid": u, "llm": pred, "clf_prob": round(pr, 4)}) + "\n")
            f.flush()
            if i % 100 == 0:
                el = time.perf_counter() - t0
                eta = (len(todo) - i) * el / i / 3600
                print(f"  {i:,}/{len(todo):,}  {el/i:.2f}s/msg  ETA {eta:.1f}h",
                      flush=True)
    print(f"done in {(time.perf_counter()-t0)/3600:.2f}h", flush=True)


if __name__ == "__main__":
    main()
