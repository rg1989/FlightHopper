#!/bin/bash
# Runs on omarchy, in ~/flighthopper-wxlab-qa or QA_DIR (see qa-omarchy.sh), on the ports QA_API, QA_FE and QA_CDP. The trap stops everything it started.
# A shot entry is "<name>|<query>" or "<name>|<query>|<step> :: <step> …": the steps are the driver's own (~/fhqa-cdp.mjs: click CSS,
# tap CSS, key KEY, eval JS, until JS, wait S …) and run after the settle time, before the shot.
# SIZE="<w> <h> <dpr> [mobile]" is the window every shot of the run is taken at (default "1440 900 1 0"; a phone: "390 844 2 mobile").
# UNCAP=1 starts Chromium with no frame-rate limit, for timing runs: a frame then takes as long as it costs.
# A folder of links, not one link to the folder: Vite keeps its cache in node_modules/.vite, and two sessions that share
# it rebuild it under each other ("Failed to fetch dynamically imported module" in the shots).
[ -e node_modules ] || { mkdir node_modules && ln -s ~/flighthopper/node_modules/* ~/flighthopper/node_modules/.bin node_modules/; }
[ -e .env.local ] || ln -s ~/flighthopper/.env.local .env.local
rm -rf shots && mkdir -p shots
API_P=${QA_API:-8798} FE_P=${QA_FE:-5198} CDP_P=${QA_CDP:-9377}
PROF=/tmp/chrome-prof-qa-$FE_P
ADSB_SOURCE=replay REPLAY_FILES="${REPLAY:-data/recordings/2026-09-23.jsonl}" PORT=$API_P RECORD_DIR= node --env-file-if-exists=.env.local server/main.ts > api.log 2>&1 &
API=$!
API_PORT=$API_P npx vite --port $FE_P --strictPort > vite.log 2>&1 &
VITE=$!
FAST=()
[ "${UNCAP:-0}" = 1 ] && FAST=(--disable-frame-rate-limit --disable-gpu-vsync)
chromium --headless=new --no-sandbox --hide-scrollbars --ignore-gpu-blocklist --use-gl=angle --use-angle=vulkan --enable-features=Vulkan "${FAST[@]}" \
  --remote-debugging-port=$CDP_P --user-data-dir=$PROF --window-size=1440,900 about:blank > chrome.log 2>&1 &
CHR=$!
trap 'kill $CHR $VITE $API 2>/dev/null; pkill -f "$PROF" 2>/dev/null; pkill -f "vite --port $FE_P" 2>/dev/null' EXIT
sleep 6
STEPS=("size ${SIZE:-1440 900 1 0}")
for a in "$@"; do
  name=${a%%|*}
  rest=${a#*|}
  query=${rest%%|*}
  # The setup guide would open on a fresh profile and cover the shot: shut unless the query asks for it.
  case "$query" in *setup=*) ;; *) query="${query:+$query&}setup=0" ;; esac
  STEPS+=("go http://localhost:$FE_P/?$query" "wait ${WAIT:-22}")
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
node ~/fhqa-cdp.mjs $CDP_P "${STEPS[@]}" "log" 2>&1 | tail -${TAIL:-80}
