# TOON Protocol local dev sandbox. See README.md for the full guide.
COMPOSE := docker compose

# The anvil service bind-mounts the connector sibling's Foundry project
# READ-WRITE and runs as the invoking user so forge's artifacts stay owned by
# the developer (vendored pattern from connector/docker-compose.yml).
export HOST_UID ?= $(shell id -u)
export HOST_GID ?= $(shell id -g)

.PHONY: setup up down clean smoke smoke-ario smoke-toon logs ps

## one-time: install the script deps (needed by `make smoke` on the host)
setup:
	npm ci

## start everything (chains + init jobs + gateway + bundler + TOON layer)
up:
	$(COMPOSE) up -d --build

## stop the stack (keeps state: gateway sqlite, localstack S3, postgres)
down:
	$(COMPOSE) down

## stop the stack and wipe ALL local state (next `make up` is a cold start).
## `-v` also removes the connectors' claim-journal volumes — load-bearing: a
## journal left behind pairs a live replay watermark with a wiped chain and
## satisfies the next smoke's payment assertion without it having paid.
## Some services run as root and leave root-owned files in ./data, so the
## wipe happens inside a throwaway container rather than needing sudo.
clean:
	$(COMPOSE) down -v --remove-orphans
	rm -rf .toon-client
	@if [ -d data ]; then \
		docker run --rm -v "$$(pwd)/data:/wipe" alpine:3.20 sh -c 'rm -rf /wipe/* /wipe/.[!.]* /wipe/..?*' 2>/dev/null; \
		rmdir data; \
	fi

## end-to-end proof: AR.IO flow (upload -> buy name -> serve) + TOON flow
## (contracts/program live -> paid write -> paid store blob via peering ->
## paid gas quote via peering, with claim journals asserted)
smoke: smoke-ario smoke-toon

smoke-ario:
	node scripts/smoke-test.mjs

smoke-toon:
	node scripts/smoke-toon.mjs

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps -a
