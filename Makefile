# Quick start: API server in the background, Vite in the foreground; Ctrl+C stops both.
#   make            replay the most recently modified recording (REC=data/recordings/<file>.jsonl to pick one)
#   make live       live adsb.lol (refuses while the recorder polls it: only one process may)
REC ?= $(shell ls -t data/recordings/*.jsonl 2>/dev/null | head -1)
FE_PORT ?= 5173
# adsb.lol from this IP: 429s at 0.14–0.5 req/s and once at ~0.082 after 1.5 h; clean at 0.041 since (2026-09-22).
LIVE_RPS ?= 0.04

.PHONY: start live run

start:
	@$(MAKE) --no-print-directory run SRC="ADSB_SOURCE=replay REPLAY_FILES=$(REC) RECORD_DIR="

live:
	@if pgrep -f record-cells >/dev/null; then echo "The recorder is polling adsb.lol (one poller at a time): pkill -f record-cells first."; exit 1; fi
	@$(MAKE) --no-print-directory run SRC="ADSB_SOURCE=adsblol MAX_RPS=$(LIVE_RPS)"

# ponytail: the API port is fixed at 8787 because vite.config.ts proxies /api there.
run:
	@if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then echo "Port 8787 is busy: stop the other API server first."; exit 1; fi
	@env $(SRC) npm run --silent server & trap 'kill $$! 2>/dev/null' EXIT INT TERM; \
	echo ""; echo "  FlightHopper → http://localhost:$(FE_PORT)/"; echo ""; \
	npx vite --port $(FE_PORT) --strictPort --clearScreen false
