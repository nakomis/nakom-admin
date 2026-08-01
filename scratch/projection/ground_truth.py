"""Classify transcript messages exactly, then grade the regex heuristic (HOME-311)."""
import glob, json, os, re, sys
from collections import Counter

sys.path.insert(0, ".")
TOOL_RE = re.compile(
    r"^\s*[\[{]|<system-reminder>|<function_results>|<command-name>|<local-command"
    r"|tool_use_error|^Caveat:|^Web search results for query:|Request interrupted"
    r"|doesn't want to proceed with this tool use|^Result of calling"
    r"|^Shell cwd was reset to", re.IGNORECASE)

def truth(entry):
    """Ground truth from transcript structure."""
    t = entry.get("type")
    m = entry.get("message") or {}
    c = m.get("content")
    if t == "assistant":
        return "claude"
    if t != "user":
        return None
    if isinstance(c, str):
        return "martin"
    if isinstance(c, list):
        kinds = {b.get("type") for b in c if isinstance(b, dict)}
        if kinds == {"text"}:
            return "harness"       # interrupts, system notices
        return "tool"
    return None

def flatten(m):
    c = m.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for b in c:
            if not isinstance(b, dict): continue
            if b.get("type") == "text": out.append(b.get("text",""))
            elif b.get("type") == "tool_result":
                x = b.get("content")
                out.append(x if isinstance(x,str) else json.dumps(x))
        return "\n".join(out)
    return ""

files = glob.glob(os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True)
gt, texts = {}, {}
counts = Counter()
for f in files:
    for line in open(f, errors="ignore"):
        try: o = json.loads(line)
        except: continue
        a = truth(o)
        if a is None: continue
        u = o.get("uuid")
        if not u: continue
        gt[u] = a; texts[u] = flatten(o.get("message") or {})
        counts[a] += 1

print(f"{len(files)} transcripts, {len(gt):,} classifiable entries")
print(f"ground truth: {dict(counts)}")
tot = sum(counts.values())
for k,v in counts.most_common():
    print(f"   {k:<8} {v:>7,}  {100*v/tot:>5.1f}%")
json.dump(gt, open("ground_truth.json","w"))
json.dump(texts, open("gt_texts.json","w"))

# Grade the regex on the entries we have truth for
print("\n--- regex vs ground truth (author='tool' detection) ---")
tp=fp=fn=tn=0
for u,a in gt.items():
    t = texts[u]
    pred_tool = bool(len(t)<12 or TOOL_RE.search(t))
    is_tool = a in ("tool","harness")
    if pred_tool and is_tool: tp+=1
    elif pred_tool and not is_tool: fp+=1
    elif not pred_tool and is_tool: fn+=1
    else: tn+=1
prec = tp/(tp+fp) if tp+fp else 0
rec  = tp/(tp+fn) if tp+fn else 0
print(f"  tp={tp:,}  fp={fp:,}  fn={fn:,}  tn={tn:,}")
print(f"  precision={100*prec:.1f}%   recall={100*rec:.1f}%")
print(f"  -> regex misses {fn:,} tool messages ({100*fn/(tp+fn):.0f}% of them)")
print(f"  -> and wrongly flags {fp:,} genuine messages as tool")
