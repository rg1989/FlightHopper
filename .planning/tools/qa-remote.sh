#!/bin/bash
# Runs on omarchy, in ~/flighthopper-wxlab-qa (see qa-omarchy.sh). The trap stops everything it started.
[ -e node_modules ] || ln -s ~/flighthopper/node_modules node_modules
[ -e .env.local ] || ln -s ~/flighthopper/.env.local .env.local
rm -rf shots && mkdir -p shots
ADSB_SOURCE=replay REPLAY_FILES=data/recordings/2026-09-23.jsonl PORT=8798 RECORD_DIR= node --env-file-if-exists=.env.local server/main.ts > api.log 2>&1 &
API=$!
API_PORT=8798 npx vite --port 5198 --strictPort > vite.log 2>&1 &
VITE=$!
chromium --headless=new --no-sandbox --hide-scrollbars --ignore-gpu-blocklist --use-gl=angle --use-angle=vulkan --enable-features=Vulkan \
  --remote-debugging-port=9377 --user-data-dir=/tmp/chrome-prof-wxlab --window-size=1440,900 about:blank > chrome.log 2>&1 &
CHR=$!
trap 'kill $CHR $VITE $API 2>/dev/null; pkill -f chrome-prof-wxlab 2>/dev/null; pkill -f "vite --port 5198" 2>/dev/null' EXIT
sleep 6
STEPS=("size 1440 900 1 0")
for a in "$@"; do
  STEPS+=("go http://localhost:5198/?${a#*|}" "wait ${WAIT:-22}" "shot shots/${a%%|*}.png")
done
node ~/fhqa-cdp.mjs 9377 "${STEPS[@]}" "log" 2>&1 | tail -30
