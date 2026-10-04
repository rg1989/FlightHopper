#!/bin/bash
# Runs on omarchy, in ~/flighthopper-wxlab-qa (see qa-omarchy.sh). The trap stops everything it started.
# A shot entry is "<name>|<query>" or "<name>|<query>|<step> :: <step> …": the steps are the driver's own (~/fhqa-cdp.mjs: click CSS,
# tap CSS, key KEY, eval JS, until JS, wait S …) and run after the settle time, before the shot.
# SIZE="<w> <h> <dpr> [mobile]" is the window every shot of the run is taken at (default "1440 900 1 0"; a phone: "390 844 2 mobile").
# UNCAP=1 starts Chromium with no frame-rate limit, for timing runs: a frame then takes as long as it costs.
[ -e node_modules ] || ln -s ~/flighthopper/node_modules node_modules
[ -e .env.local ] || ln -s ~/flighthopper/.env.local .env.local
rm -rf shots && mkdir -p shots
ADSB_SOURCE=replay REPLAY_FILES=data/recordings/2026-09-23.jsonl PORT=8798 RECORD_DIR= node --env-file-if-exists=.env.local server/main.ts > api.log 2>&1 &
API=$!
API_PORT=8798 npx vite --port 5198 --strictPort > vite.log 2>&1 &
VITE=$!
FAST=()
[ "${UNCAP:-0}" = 1 ] && FAST=(--disable-frame-rate-limit --disable-gpu-vsync)
chromium --headless=new --no-sandbox --hide-scrollbars --ignore-gpu-blocklist --use-gl=angle --use-angle=vulkan --enable-features=Vulkan "${FAST[@]}" \
  --remote-debugging-port=9377 --user-data-dir=/tmp/chrome-prof-wxlab --window-size=1440,900 about:blank > chrome.log 2>&1 &
CHR=$!
trap 'kill $CHR $VITE $API 2>/dev/null; pkill -f chrome-prof-wxlab 2>/dev/null; pkill -f "vite --port 5198" 2>/dev/null' EXIT
sleep 6
STEPS=("size ${SIZE:-1440 900 1 0}")
for a in "$@"; do
  name=${a%%|*}
  rest=${a#*|}
  query=${rest%%|*}
  STEPS+=("go http://localhost:5198/?$query" "wait ${WAIT:-22}")
  if [ "$rest" != "$query" ]; then
    more=${rest#*|}
    while [ -n "$more" ]; do
      step=${more%% :: *}
      STEPS+=("$step")
      [ "$step" = "$more" ] && break
      more=${more#* :: }
    done
  fi
  STEPS+=("shot shots/$name.png")
done
node ~/fhqa-cdp.mjs 9377 "${STEPS[@]}" "log" 2>&1 | tail -${TAIL:-80}
