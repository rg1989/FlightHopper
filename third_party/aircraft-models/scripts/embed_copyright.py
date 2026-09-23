#!/usr/bin/env python3
"""Batch-embed GPL attribution into the asset.copyright field of glTF 2.0 .glb files.

The glTF spec defines asset.copyright as a free-form string. We write the licence
and upstream provenance there so the statement travels with the file even when it
is downloaded on its own, which is what GPL-2.0 section 1 asks for.

Usage:
    python3 embed_copyright.py <file-or-dir> [<file-or-dir> ...]
"""
import json
import os
import struct
import sys

COPYRIGHT = (
    "GPL-2.0-or-later, derived from FlightGear / FGMEMBERS / "
    "Flightradar24 fr24-3d-models"
)

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path):
    """Return (json_dict, bin_chunk_bytes_or_None)."""
    with open(path, "rb") as fh:
        blob = fh.read()
    if blob[:4] != GLB_MAGIC:
        raise ValueError("not a binary glTF: %s" % path)
    version, _total = struct.unpack("<II", blob[4:12])
    if version != 2:
        raise ValueError("glTF %d is not supported (need 2): %s" % (version, path))

    gltf = None
    binary = None
    offset = 12
    while offset < len(blob):
        length, kind = struct.unpack("<II", blob[offset:offset + 8])
        payload = blob[offset + 8:offset + 8 + length]
        if kind == CHUNK_JSON:
            gltf = json.loads(payload.decode("utf-8"))
        elif kind == CHUNK_BIN:
            binary = payload
        offset += 8 + length
    if gltf is None:
        raise ValueError("no JSON chunk: %s" % path)
    return gltf, binary


def write_glb(path, gltf, binary):
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)          # spec: pad JSON with 0x20
    chunks = [(CHUNK_JSON, json_chunk)]
    if binary is not None:
        bin_chunk = binary + b"\x00" * (-len(binary) % 4)  # spec: pad BIN with 0x00
        chunks.append((CHUNK_BIN, bin_chunk))

    total = 12 + sum(8 + len(payload) for _, payload in chunks)
    out = bytearray()
    out += GLB_MAGIC + struct.pack("<II", 2, total)
    for kind, payload in chunks:
        out += struct.pack("<II", len(payload), kind) + payload

    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(out)
    os.replace(tmp, path)


def stamp(path):
    gltf, binary = read_glb(path)
    asset = gltf.setdefault("asset", {})
    if asset.get("copyright") == COPYRIGHT:
        return "skip"
    asset["copyright"] = COPYRIGHT
    write_glb(path, gltf, binary)
    return "stamped"


def targets(argv):
    for arg in argv:
        if os.path.isdir(arg):
            for root, _dirs, files in os.walk(arg):
                for name in sorted(files):
                    if name.endswith(".glb"):
                        yield os.path.join(root, name)
        elif arg.endswith(".glb"):
            yield arg


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 2
    counts = {"stamped": 0, "skip": 0}
    for path in targets(sys.argv[1:]):
        counts[stamp(path)] += 1
    print("stamped %(stamped)d, already-correct %(skip)d" % counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
