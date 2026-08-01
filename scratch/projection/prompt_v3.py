"""Does stating a prior fix the LLM's bias? Three variants, same balanced sample."""
import json, time, urllib.request
import numpy as np, psycopg

EX = """Examples:
"{\\"result\\":[]}" -> TOOL
"Why aren't you using the Taiga MCP?" -> HUMAN
"On branch main. Your branch is up to date with 'origin/main'." -> TOOL
"Yeah, I realized embedding space was going to be an issue." -> HUMAN
"exit=0 OK Post Configure AWS credentials" -> TOOL
"Can you compare model number RC070S vs DLH05170B" -> HUMAN
"""
BASE = """You are labelling messages from a developer's AI-assistant transcript.

TOOL = emitted by a program: command output, file contents, API responses,
diffs, logs, search results, status dumps.
HUMAN = composed by the person: questions, instructions, opinions, decisions,
corrections, jokes, or short replies like "yes please".
"""
VARIANTS = {
 "few-shot (v2 baseline)": BASE + EX,
 "+ balanced prior":       BASE + "\nThis sample is 50/50 HUMAN and TOOL. Do not default to TOOL.\n" + EX,
 "+ true prior (86% tool)": BASE + "\nAbout 86% of these messages are TOOL.\n" + EX,
}
TAIL = """
Message:
---
{text}
---
One word, HUMAN or TOOL:"""

def ask(pfx, text):
    body=json.dumps({"model":"llama3.2:3b","prompt":pfx+TAIL.replace("{text}",text[:700]),
        "stream":False,"options":{"temperature":0,"num_predict":5}}).encode()
    r=urllib.request.Request("http://localhost:11434/api/generate",data=body,
        headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(r,timeout=90) as f:
        o=json.loads(f.read())["response"].strip().upper()
    return "martin" if "HUMAN" in o else ("tool" if "TOOL" in o else None)

gt=json.load(open("ground_truth.json"))
with psycopg.connect("postgres://claude:claude@172.29.0.30:5432/claude_chats") as c,c.cursor() as cur:
    cur.execute("SELECT message_uuid, content FROM messages WHERE embedding IS NOT NULL AND role='user'")
    rows=[(u,t) for u,t in cur.fetchall() if u in gt]
M=[r for r in rows if gt[r[0]]=="martin"]; T=[r for r in rows if gt[r[0]] in ("tool","harness")]
rng=np.random.default_rng(7)
samp=[(M[i],"martin") for i in rng.choice(len(M),100,replace=False)] + \
     [(T[i],"tool")   for i in rng.choice(len(T),100,replace=False)]

print(f"{'variant':<26} {'human rec':>10} {'tool rec':>9} {'balanced':>9}")
for name,pfx in VARIANTS.items():
    hit={"martin":0,"tool":0}; tot={"martin":0,"tool":0}
    for (u,txt),truth in samp:
        p=ask(pfx,txt)
        if p is None: continue
        tot[truth]+=1; hit[truth]+=(p==truth)
    bal=0.5*(hit["martin"]/max(tot["martin"],1)+hit["tool"]/max(tot["tool"],1))
    print(f"{name:<26} {100*hit['martin']/max(tot['martin'],1):>9.1f}% "
          f"{100*hit['tool']/max(tot['tool'],1):>8.1f}% {100*bal:>8.1f}%")
print(f"\n{'embeddings + logreg':<26} {92.9:>9.1f}% {93.7:>8.1f}% {93.3:>8.1f}%")
