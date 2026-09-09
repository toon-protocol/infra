# TOON Protocol local dev sandbox. See README.md for the full guide.
COMPOSE := docker compose

.PHONY: setup up down clean smoke logs ps

## one-time: install the script deps (needed by `make smoke` on the host)
setup:
	npm ci

## start everything (chains + init jobs + gateway + bundler)
up:
	$(COMPOSE) up -d --build

## stop the stack (keeps state: gateway sqlite, localstack S3, postgres)
down:
	$(COMPOSE) down

## stop the stack and wipe ALL local state (next `make up` is a cold start).
## Some services run as root and leave root-owned files in ./data, so the
## wipe happens inside a throwaway container rather than needing sudo.
clean:
	$(COMPOSE) down -v --remove-orphans
	@if [ -d data ]; then \
		docker run --rm -v "$$(pwd)/data:/wipe" alpine:3.20 sh -c 'rm -rf /wipe/* /wipe/.[!.]* /wipe/..?*' 2>/dev/null; \
		rmdir data; \
	fi

## end-to-end proof: upload -> buy ArNS name -> serve by name (+ anvil/arlocal checks)
smoke:
	node scripts/smoke-test.mjs

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps -a
