#!/bin/bash
# Visual check of this worktree on omarchy (the idle Linux box), never on the Mac: copies the tree there, starts a replay
# API (8798) and vite (5198) and ONE headless Chromium, takes the shots, stops all three, and brings the shots back.
#   .planning/tools/qa-omarchy.sh <out-dir> "<name>|<query>" ["<name>|<query>|<step> :: <step>" …]
# Each query goes after http://localhost:5198/? ; e.g. "far|hex=a831b2&chase=1&cam=20,-25,50000&wx=1&wxdemo=1". An entry may carry
# steps to run before its shot (qa-remote.sh), e.g. "menu|hex=…&wx=1|click .fh-corner-b[data-id=weather] button :: wait 1".
# WAIT=<s> (default 22) is the settle time before each shot; SIZE="<w> <h> <dpr> [mobile]" the window (default "1440 900 1 0");
# UNCAP=1 takes Chromium's frame-rate limit off (timing runs). Never touches ~/flighthopper there (the TV's own app).
set -e
OUT=$1; shift
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude data/recordings --exclude .env.local --exclude shots --exclude '*.log' "$ROOT/" omarchy:flighthopper-wxlab-qa/
ARGS=$(printf ' %q' "$@")
ssh omarchy "cd ~/flighthopper-wxlab-qa && WAIT=${WAIT:-22} SIZE=$(printf %q "${SIZE:-1440 900 1 0}") UNCAP=${UNCAP:-0} TAIL=${TAIL:-80} bash .planning/tools/qa-remote.sh$ARGS"
mkdir -p "$OUT"
scp -q "omarchy:flighthopper-wxlab-qa/shots/*.png" "$OUT/"
ls "$OUT"
