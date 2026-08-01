#!/usr/bin/env python3
"""Pack projections into a single self-contained HTML viewer (ADMIN-12).

The artefact must open from file:// with no network access of any kind, which
rules out fetching the data alongside it: Chrome blocks fetch() from file://.
So the data is inlined -- and raw JSON is far too big to inline five times
(~3.8 MB each, ~15 MB total).

Coordinates are therefore quantised to int16 over each projection's own
bounding box. UMAP output is a relative layout with no meaningful units, so
1/65536 of the extent is far below anything the eye or the renderer can
resolve. That takes a node from ~40 bytes of JSON to 8 bytes of binary:

    int16 x, int16 y, int16 z, uint16 cluster, uint8 author, uint8 pad

35,000 nodes then cost ~280 KB raw, ~370 KB as base64 -- so all five
projections inline comfortably inside a couple of MB of HTML.
"""
import base64
import json
import pathlib
import struct
import sys

AUTHOR_CODE = {"m": 0, "c": 1, "t": 2}


def pack(doc):
    nodes = doc["nodes"]
    if not nodes:
        return None
    xs = [n["x"] for n in nodes]
    ys = [n["y"] for n in nodes]
    zs = [n["z"] for n in nodes]
    lo = [min(xs), min(ys), min(zs)]
    hi = [max(xs), max(ys), max(zs)]
    # Guard the degenerate axis: a projection could in principle be flat in one
    # dimension, and dividing by a zero span would produce NaNs for every node.
    span = [(h - l) or 1.0 for l, h in zip(lo, hi)]

    buf = bytearray()
    for n in nodes:
        q = [
            int(round((v - l) / s * 65535)) - 32768
            for v, l, s in zip((n["x"], n["y"], n["z"]), lo, span)
        ]
        buf += struct.pack(
            "<hhhHBB",
            max(-32768, min(32767, q[0])),
            max(-32768, min(32767, q[1])),
            max(-32768, min(32767, q[2])),
            # Cluster -1 (scatter) is already dropped upstream, but clamp
            # rather than trusting it -- a negative id would wrap to 65535 and
            # silently merge with a real cluster.
            max(0, min(65535, n["c"])),
            AUTHOR_CODE.get(n.get("a", "m"), 0),
            0,
        )

    # Intra-cluster edges, packed as uint16 index pairs plus a uint8 similarity.
    # uint16 is sufficient because no projection exceeds 65,535 nodes; the
    # similarity is only used for line opacity, so a byte of precision is
    # generous. 5 bytes an edge against ~30 as JSON.
    ebuf = bytearray()
    edges = doc.get("edges") or []
    for a, b, sim in edges:
        if a > 65535 or b > 65535:
            continue
        # Similarity is bounded below by the edge floor, so rescale from there
        # rather than from 0 — otherwise every edge lands in the top of the
        # byte range and the opacity ramp does nothing.
        q = int(max(0.0, min(1.0, (sim - 0.5) / 0.5)) * 255)
        ebuf += struct.pack("<HHB", a, b, q)

    clusters = {c["id"]: c for c in doc.get("clusters", [])}
    return {
        "name": doc["name"],
        "authors": doc.get("authors", []),
        "total": doc.get("total", len(nodes)),
        "kept": doc.get("kept", len(nodes)),
        "lo": lo,
        "span": span,
        "n": len(nodes),
        "data": base64.b64encode(bytes(buf)).decode(),
        "edges": base64.b64encode(bytes(ebuf)).decode(),
        "n_edges": len(ebuf) // 5,
        "clusters": [
            {"id": int(k), "size": v.get("size", 0), "label": v.get("label")}
            for k, v in sorted(clusters.items())
        ],
    }


def main():
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "graph.html")
    template = pathlib.Path(__file__).with_name("viewer.html").read_text()

    packed = {}
    for name in ("martin", "claude", "tool", "martin-claude", "all"):
        f = src / f"projv2-{name}.json"
        if not f.exists():
            print(f"  skip {name} (no {f.name})")
            continue
        p = pack(json.loads(f.read_text()))
        if p:
            packed[name] = p
            print(f"  {name:<14} {p['n']:>7,} nodes  {p['n_edges']:>7,} edges  "
                  f"{(len(p['data']) + len(p['edges']))/1e6:>5.2f} MB b64")

    if not packed:
        sys.exit("no projections found")

    token = "/*__DATA__*/{}"
    if token not in template:
        sys.exit("viewer.html is missing the /*__DATA__*/{} placeholder")
    html = template.replace(token, json.dumps(packed, separators=(",", ":")))
    out.write_text(html)
    print(f"\nwrote {out} ({out.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
