# Quick start: API server in the background, Vite in the foreground; Ctrl+C stops both.
#   make / make live   live traffic from adsb.fi (paced below its 1 req/s public limit)
#   make replay        replay the most recently modified recording (REC=data/recordings/<file>.jsonl to pick one)
#   make live LIVE_SOURCE=adsblol   live from adsb.lol at 0.04 req/s (refuses while the recorder polls it)
REC ?= $(shell ls -t data/recordings/*.jsonl 2>/dev/null | head -1)
FE_PORT ?= 5173
API_PORT ?= 8787
LIVE_SOURCE ?= adsbfi
# Passed explicitly so a MAX_RPS in .env.local never raises them: adsb.fi's public limit is 1 req/s; adsb.lol refused
# this IP at 0.08-0.5 req/s and has run clean at 0.04 (2026-09-22).
LIVE_RPS_adsbfi = 0.9
LIVE_RPS_adsblol = 0.04
# make live records nothing unless asked (LIVE_RECORD_DIR=data/live): a RECORD_DIR from .env.local would append its
# answers to the recorder's adsb.lol day files in data/recordings, which make replay then plays as one mixed recording.
LIVE_RECORD_DIR ?=

.PHONY: live start replay run

live:
	@if [ "$(LIVE_SOURCE)" = adsblol ] && pgrep -f record-cells >/dev/null; then echo "The recorder is polling adsb.lol (one poller at a time): pkill -f record-cells first, or use adsb.fi (make live)."; exit 1; fi
	@$(MAKE) --no-print-directory run SRC="ADSB_SOURCE=$(LIVE_SOURCE) MAX_RPS=$(LIVE_RPS_$(LIVE_SOURCE)) RECORD_DIR=$(LIVE_RECORD_DIR)"

start: live

replay:
	@$(MAKE) --no-print-directory run SRC="ADSB_SOURCE=replay REPLAY_FILES=$(REC) RECORD_DIR="

# vite.config.ts proxies /api to API_PORT.
run:
	@if lsof -nP -iTCP:$(API_PORT) -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $(API_PORT) is busy: stop the other API server first (two live servers would double the upstream rate from this IP)."; exit 1; fi
	@env $(SRC) PORT=$(API_PORT) npm run --silent server & trap 'kill $$! 2>/dev/null' EXIT INT TERM; \
	echo ""; echo "  FlightHopper → http://localhost:$(FE_PORT)/"; echo ""; \
	API_PORT=$(API_PORT) npx vite --port $(FE_PORT) --strictPort --clearScreen false
