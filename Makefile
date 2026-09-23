# Quick start: API server in the background, Vite in the foreground; Ctrl+C stops both.
#   make            replay the newest recording (REC=data/recordings/<file>.jsonl to pick one)
#   make live       live adsb.lol (stop the recorder first: only one process may poll it)
REC ?= $(lastword $(sort $(wildcard data/recordings/*.jsonl)))
FE_PORT ?= 5173

.PHONY: start live run

start:
	@$(MAKE) --no-print-directory run SRC="ADSB_SOURCE=replay REPLAY_FILES=$(REC) RECORD_DIR="

live:
	@$(MAKE) --no-print-directory run SRC="ADSB_SOURCE=adsblol"

# ponytail: the API port is fixed at 8787 because vite.config.ts proxies /api there.
run:
	@if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then echo "Port 8787 is busy: stop the other API server first."; exit 1; fi
	@env $(SRC) npm run --silent server & trap 'kill $$! 2>/dev/null' EXIT INT TERM; \
	echo ""; echo "  FlightHopper → http://localhost:$(FE_PORT)/"; echo ""; \
	npx vite --port $(FE_PORT) --strictPort --clearScreen false
