# TOON Protocol local dev sandbox. See README.md for the full guide.

# Every service in docker-compose.yml carries a profile, so a profile is always
# selected here (see the "Profiles" block at the top of that file).
#   full      the whole 21-service stack — the sandbox's default
#   payments  chains + hub + seed/open jobs only, no store checkout needed
# Recursively expanded (`=`, not `:=`) so the payments targets can override
# COMPOSE_PROFILE for their own recipes.
COMPOSE_PROFILE ?= full
COMPOSE = docker compose --profile $(COMPOSE_PROFILE)

# The anvil service bind-mounts the connector sibling's Foundry project
# READ-WRITE and runs as the invoking user so forge's artifacts stay owned by
# the developer (vendored pattern from connector/docker-compose.yml).
export HOST_UID ?= $(shell id -u)
export HOST_GID ?= $(shell id -g)

.PHONY: setup up up-payments down clean smoke smoke-ario smoke-toon \
        smoke-payments logs ps require-store-context

# The store image is BUILT from the store sibling checkout carrying the
# local-endpoint-override change (STORE_TURBO_UPLOAD_URL / ARNS_SOLANA_*_URL);
# the pinned upstream image predates it. See docker-compose.yml (store) and
# README "Prerequisites".
STORE_CONTEXT := ../../store-gaps-worktree

# Hard gate for the paths that BUILD the store image — i.e. `make up` alone.
# The payments profile never renders the `store` service, so nothing on that
# path needs the checkout to exist.
require-store-context:
	@if [ ! -f "$(STORE_CONTEXT)/Dockerfile.store" ]; then \
		echo "ERROR: store checkout not found at $(STORE_CONTEXT)"; \
		echo "The sandbox builds the store image from a sibling checkout of the"; \
		echo "store repo that contains the local-endpoint-override change"; \
		echo "(branch feat/local-endpoint-overrides — STORE_TURBO_UPLOAD_URL,"; \
		echo "ARNS_SOLANA_RPC_URL/ARNS_SOLANA_WS_URL). Clone/see it there, or"; \
		echo "update STORE_CONTEXT in the Makefile + the store build context in"; \
		echo "docker-compose.yml to where your checkout lives."; \
		echo; \
		echo "Only the FULL stack needs it. If you are working on the payment"; \
		echo "layer, use \`make up-payments\` + \`make smoke-payments\` instead."; \
		exit 1; \
	fi

## one-time: install the script deps (needed by `make smoke` on the host).
## Deliberately does NOT require the store checkout — a payments-only
## developer must be able to run setup, up-payments and smoke-payments with no
## sibling checkout at all; `make up` is where that requirement is enforced.
setup:
	@if [ ! -f "$(STORE_CONTEXT)/Dockerfile.store" ]; then \
		echo "NOTE: no store checkout at $(STORE_CONTEXT)."; \
		echo "      Fine for \`make up-payments\` / \`make smoke-payments\`;"; \
		echo "      \`make up\` (full stack) will stop and explain until it exists."; \
		echo; \
	fi
	npm ci

## start everything (chains + init jobs + gateway + bundler + TOON layer)
up: require-store-context
	$(COMPOSE) up -d --build

## start the PAYMENT LAYER ONLY: anvil + solana-validator + their seed jobs +
## the relay + the hub + the Solana channel-open job (7 services). No gateway,
## no bundler, no store, no gas station — and no store sibling checkout.
up-payments: COMPOSE_PROFILE = payments
up-payments:
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

## payment-layer proof for `make up-payments`: the same smoke-toon.mjs, told to
## stop after the payment layer — contracts/program live, the hub's two SOLANA
## peering channels open and collateralised, an EVM channel opened against the
## hub, a PAID write routed through it, and the hub's own claim journal
## advanced on that channel. No store, gateway or bundler assertions.
smoke-payments:
	TOON_SMOKE_PAYMENTS_ONLY=1 node scripts/smoke-toon.mjs

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps -a
