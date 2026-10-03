#!/bin/bash
# Tests and the typecheck on omarchy (the idle Linux box), so the Mac runs nothing but the edits:
#   .planning/tools/remote-check.sh test client/scene/a.test.ts [more.test.ts …]
#   .planning/tools/remote-check.sh tsc
#   .planning/tools/remote-check.sh all        (npm run check: the typecheck and every test)
# It copies this tree to ~/flighthopper-wxlab-qa there first. Never touches ~/flighthopper (the TV's own app).
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude data/recordings --exclude .env.local --exclude shots --exclude '*.log' "$ROOT/" omarchy:flighthopper-wxlab-qa/
PRE='cd ~/flighthopper-wxlab-qa && { [ -e node_modules ] || ln -s ~/flighthopper/node_modules node_modules; } &&'
case "$1" in
  test) shift; ssh omarchy "$PRE node --test $(printf ' %q' "$@")" ;;
  tsc) ssh omarchy "$PRE npx tsc --noEmit -p . && echo 'tsc: clean'" ;;
  all) ssh omarchy "$PRE npm run check" ;;
  *) echo "usage: remote-check.sh test <files…> | tsc | all" >&2; exit 2 ;;
esac
