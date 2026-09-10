# TOON Protocol local dev sandbox. See README.md for the full guide.
COMPOSE := docker compose

# The anvil service bind-mounts the connector sibling's Foundry project
# READ-WRITE and runs as the invoking user so forge's artifacts stay owned by
# the developer (vendored pattern from connector/docker-compose.yml).
export HOST_UID ?= $(shell id -u)
export HOST_GID ?= $(shell id -g)

.PHONY: setup up down clean smoke smoke-ario smoke-toon logs ps

# The store image is BUILT from the store sibling checkout carrying the
# local-endpoint-override change (STORE_TURBO_UPLOAD_URL / ARNS_SOLANA_*_URL);
# the pinned upstream image predates it. See docker-compose.yml (store) and
# README "Prerequisites".
STORE_CONTEXT := ../../store-gaps-worktree

# The claim-minter image is BUILT from the anytoon sibling checkout (there is
# no published image for it). Exported, so docker-compose.yml's build context
# `${ANYTOON_CONTEXT:-../../anytoon}/claim-minter` picks it up — repoint it
# here (or in your environment) if your checkout lives elsewhere. Keep the
# default RELATIVE: the compose file has to stay portable.
export ANYTOON_CONTEXT ?= ../../anytoon

## one-time: install the script deps (needed by `make smoke` on the host)
setup:
	@if [ ! -f "$(STORE_CONTEXT)/Dockerfile.store" ]; then \
		echo "ERROR: store checkout not found at $(STORE_CONTEXT)"; \
		echo "The sandbox builds the store image from a sibling checkout of the"; \
		echo "store repo that contains the local-endpoint-override change"; \
		echo "(branch feat/local-endpoint-overrides — STORE_TURBO_UPLOAD_URL,"; \
		echo "ARNS_SOLANA_RPC_URL/ARNS_SOLANA_WS_URL). Clone/see it there, or"; \
		echo "update STORE_CONTEXT in the Makefile + the store build context in"; \
		echo "docker-compose.yml to where your checkout lives."; \
		exit 1; \
	fi
	@if [ ! -f "$(ANYTOON_CONTEXT)/claim-minter/Dockerfile" ]; then \
		echo "ERROR: anytoon checkout not found at $(ANYTOON_CONTEXT)"; \
		echo "The sandbox builds the claim-minter image from a sibling checkout"; \
		echo "of the anytoon repo (it publishes no image). Clone it there, or"; \
		echo "set ANYTOON_CONTEXT to where your checkout lives:"; \
		echo "    make up ANYTOON_CONTEXT=/path/to/anytoon"; \
		exit 1; \
	fi
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
## brokered ArNS buy: paid 5095 prepare + 5096 gas spawn + 5095 buy, name
## resolves -> paid gas jobs via peering: Solana quote + EVM ERC-2771
## meta-tx relay, with claim journals asserted per settlement leg)
smoke: smoke-ario smoke-toon

smoke-ario:
	node scripts/smoke-test.mjs

smoke-toon:
	node scripts/smoke-toon.mjs

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps -a
