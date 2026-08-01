#!/usr/bin/env python3
"""Give every cluster a name (HOME-308).

A coloured blob labelled "cluster 223" tells a viewer nothing. The projection
is only interesting once you can see that *this* lobe is deployment failures
and *that* one is 3D printing.

Labels come from class-based TF-IDF, not from an LLM. The distinction matters:
c-TF-IDF asks "which terms are frequent in this cluster and rare in the rest of
the corpus", which is exactly the question a label answers, and it is
deterministic, free, and runs in seconds over the whole corpus. An LLM asked to
name a cluster has to be shown a sample, and a sample of a 3,000-message
cluster is a guess about the other 2,990.

So the LLM, if used at all, is a second pass that turns c-TF-IDF's terms into
readable English (--ollama) — it renames, it does not decide. When it is off,
the raw terms are the label, which is uglier but never wrong about what the
cluster contains.

Ordinary TF-IDF would not work here. It weights terms per *document*, and a
document is one message; the frequent terms would be whatever that message
happened to repeat. Concatenating each cluster into a single pseudo-document
first is what makes the comparison between clusters rather than between
messages.
"""
import argparse
import json
import math
import pathlib
import re
import sys
import time
from collections import Counter

import psycopg

# Stop words plus the vocabulary of this particular corpus. "claude", "file",
# "code" and friends are perfectly good English content words that happen to
# appear in nearly every cluster here, so they carry no discriminating power
# and would otherwise dominate every label. This list is corpus-specific by
# design — it is not a general stop list and should not be reused as one.
STOP = set("""
a about after all also am an and any are as at be because been before being but
by can cant could did do does doing done dont down each else even ever every few
for from further get got had has have having he her here hers him his how i if in
into is it its itself just like me more most much must my no nor not now of off
on once only or other our out over own re same she should so some such than that
the their them then there these they this those through to too under until up us
use used using very was we well were what when where which while who whom why
will with would you your yours
ok okay yes yeah yep nope thanks thank please sure right sorry
claude code file files line lines run running ran command output error errors
need needs want add added adding change changed make made new one two three
think know see look looking try trying work working thing things way ways
let lets going go went back time first last still bit really actually
""".split())

WORD = re.compile(r"[a-z][a-z0-9_.-]{2,}")


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def is_junk(w):
    """Machine-generated identifiers, which are not topics.

    Temp paths, hashes and UUID fragments cluster beautifully — they really do
    co-occur — so c-TF-IDF scores them highly and they crowd out the word that
    would have explained the cluster. Two cheap signals catch nearly all of
    them: implausible length, and letters and digits interleaved rather than a
    word with a version number on the end.
    """
    if len(w) > 18:
        return True
    digits = sum(c.isdigit() for c in w)
    return digits >= 3 and digits < len(w) and not w[0].isdigit()


def tokens(text):
    for w in WORD.findall(text.lower()):
        w = w.strip("._-")
        if len(w) > 2 and w not in STOP and not w.isdigit() and not is_junk(w):
            yield w


def ctfidf(docs, top_n):
    """Top terms per cluster by class-based TF-IDF.

    `docs` maps cluster id -> Counter of term frequencies for the whole
    cluster. Weight is (term freq in cluster, L1-normalised) x log(1 + total
    clusters / clusters containing the term) — the standard c-TF-IDF used by
    topic models, which rewards a term for being common *here* and absent
    *elsewhere*.
    """
    n_clusters = len(docs)
    doc_freq = Counter()
    for counts in docs.values():
        doc_freq.update(counts.keys())

    out = {}
    for cid, counts in docs.items():
        total = sum(counts.values()) or 1
        scored = [
            (t, (f / total) * math.log(1 + n_clusters / doc_freq[t]))
            for t, f in counts.items()
            # A term appearing once in a large cluster is noise, not a topic.
            if f >= 2 or total < 200
        ]
        scored.sort(key=lambda x: -x[1])
        out[cid] = [t for t, _ in scored[:top_n]]
    return out


def phrase(terms):
    """Fallback label: the top few terms, comma-joined."""
    return ", ".join(terms[:3]) if terms else None


def ollama_label(terms, samples, model, endpoint):
    """Turn terms into a short English phrase. Returns None on any failure.

    Deliberately best-effort: a label is decoration, and a labelling run that
    aborts because a local model is not loaded would be a much worse outcome
    than a run that falls back to the raw terms.
    """
    import urllib.error
    import urllib.request

    prompt = (
        "These keywords were extracted from a cluster of messages in a "
        "software engineering chat log:\n\n"
        + ", ".join(terms[:12])
        + "\n\nHere are three example messages from the cluster:\n\n"
        + "\n---\n".join(s[:300] for s in samples)
        + "\n\nReply with a topic label of at most five words describing what "
        "this cluster is about. Reply with the label only — no quotes, no "
        "explanation, no trailing full stop."
    )
    body = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 24},
    }).encode()
    try:
        req = urllib.request.Request(
            endpoint.rstrip("/") + "/api/generate", data=body,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            text = json.loads(r.read())["response"]
    except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
        log(f"  ollama failed ({e}); falling back to terms")
        return None

    label = " ".join(text.strip().strip('"').split())
    # A model that ignores "five words" and writes a paragraph has not produced
    # a label; the terms are better than a truncated sentence.
    return label if label and len(label) <= 60 else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", required=True)
    p.add_argument("--dir", default=".")
    p.add_argument("--prefix", default="projv2")
    p.add_argument("--top-n", type=int, default=12)
    p.add_argument("--ollama", metavar="MODEL",
                   help="refine labels with a local Ollama model, e.g. llama3.2")
    p.add_argument("--ollama-endpoint", default="http://127.0.0.1:11434")
    a = p.parse_args()

    src = pathlib.Path(a.dir)
    files = [f for f in sorted(src.glob(f"{a.prefix}-*.json"))
             if not f.name.endswith("-manifest.json")]
    if not files:
        sys.exit(f"no {a.prefix}-*.json under {src}")

    t0 = time.perf_counter()
    with psycopg.connect(a.dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT id::text, content FROM messages WHERE embedding IS NOT NULL")
        text_by_id = dict(cur.fetchall())
    log(f"fetched {len(text_by_id):,} message bodies in {time.perf_counter() - t0:.0f}s")

    for f in files:
        doc = json.loads(f.read_text())
        nodes = doc.get("nodes") or []
        if not nodes:
            continue

        docs, samples = {}, {}
        for node in nodes:
            body = text_by_id.get(node["id"])
            if not body:
                continue
            cid = node["c"]
            docs.setdefault(cid, Counter()).update(tokens(body))
            s = samples.setdefault(cid, [])
            if len(s) < 3:
                s.append(body)

        terms = ctfidf(docs, a.top_n)

        labelled = 0
        for c in doc.get("clusters", []):
            t = terms.get(c["id"])
            if not t:
                continue
            c["terms"] = t[:8]
            c["label"] = None
            if a.ollama:
                c["label"] = ollama_label(
                    t, samples.get(c["id"], []), a.ollama, a.ollama_endpoint)
            if not c["label"]:
                c["label"] = phrase(t)
            labelled += 1

        doc["label_method"] = f"c-tf-idf+{a.ollama}" if a.ollama else "c-tf-idf"
        f.write_text(json.dumps(doc))
        log(f"{f.name:<28} labelled {labelled}/{len(doc.get('clusters', []))} clusters")


if __name__ == "__main__":
    main()
