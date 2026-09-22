# TOON Protocol local dev sandbox. See README.md for the full guide.

# Every service in docker-compose.yml carries a profile, so a profile is always
# selected here (see the "Profiles" block at the top of that file).
#   full         the whole stack, every service — the sandbox's default
#   payments     chains + hub + seed/open jobs only, no sibling app checkout
#                needed beyond the connector's
#   credentials  `payments` PLUS the Anyone credentials issuer path and the
#                swap driver — the denomination boundary without the permaweb
#                half. Needs the anytoon checkout, NOT the store one
#   hs           `full` PLUS the anon daemon, its forwarder, the buyer's SOCKS
#                proxy and THE HIDDEN PROVIDER (its own daemon, connector,
#                publisher and provider app, TOON_Network #43) — OPT-IN
#                (`make up-hs`), never part of `up`/`smoke`
#   gateway      `full` (or `payments`) PLUS the WORKLOAD GATEWAY and its own
#                connector (TOON_Network ADR 0013, spec §12, Milestone 5) —
#                `make up-gateway`; `make up-gateway-hs` puts it on top of
#                `up-hs` for the hidden path by hand
# Recursively expanded (`=`, not `:=`) so the payments targets can override
# COMPOSE_PROFILE for their own recipes.
COMPOSE_PROFILE ?= full
COMPOSE = docker compose --profile $(COMPOSE_PROFILE)

# `up-hs` is `full` PLUS `hs`: three services on top of the whole stack, never a
# stack of their own. What it does change about `full` is what the anytoon node
# ADVERTISES — the rendered config below points its [node] endpoints at the
# generated `.anyone` address, because a client dials what a node publishes.
# The hub is unaffected (it dials its own [[peers]] endpoint); a clearnet client
# aimed straight at localhost:3230 is not. See README §2 + §6.6.
COMPOSE_HS = docker compose --profile full --profile hs

# `up-gateway` is `$(COMPOSE_PROFILE)` PLUS `gateway`: the Workload Gateway and
# its connector on top of the whole stack (or, with COMPOSE_PROFILE=payments,
# of the payment layer — the two providers and the relay are all it needs).
COMPOSE_GW = $(COMPOSE) --profile gateway

# down/clean must sweep EVERY profile's containers, whichever one brought them
# up — otherwise `make up-hs && make down` leaves three daemons running.
COMPOSE_ALL = docker compose --profile full --profile payments --profile credentials --profile hs --profile gateway

# The buyer's SOCKS5 port on the host's loopback. 19050, not 9050: a developer's
# own anon/Tor daemon usually holds 9050 and a second bind fails the bring-up.
# docker-compose.yml publishes it and scripts/smoke-hs.mjs dials it.
export ANON_SOCKS_PORT ?= 19050

# The rendered anytoon-connector config `make up-hs` mounts in place of the
# committed one: same file, [node] endpoints pointed at the daemon's generated
# `.anyone` address. Written by scripts/hs-address.sh; gitignored; wiped by
# `make clean`. Nothing else ever sets ANYTOON_CONNECTOR_CONF, so every other
# target renders the committed config.
HS_CONNECTOR_CONF = ./conf/.rendered/connector-anytoon.toml

# THE HIDDEN PROVIDER'S rendered configs (TOON_Network #43), written by
# scripts/hs-provider-address.sh with the address `anon-hs` generated. Two of
# them are named here because two services mount them; the third
# (conf/.rendered/hs-provider.env, the publisher's endpoints) is named by
# docker-compose.yml's `env_file` instead. A hidden provider publishes its
# address twice over — its connector advertises it, and its Provider Profile
# carries it as `connector_url`, which `hidden = true` refuses to start
# without — and reaches its own relay and hub over it as well.
HS_PROVIDER_CONNECTOR_CONF = ./conf/.rendered/connector-provider-hs.toml
HS_PROVIDER_CONF = ./conf/.rendered/provider-hs.toml

# THE WORKLOAD GATEWAY (TOON_Network #53) is BUILT from the gateway sibling
# checkout (toon-protocol/gateway; it publishes no image). Exported, so
# docker-compose.yml's build context `${GATEWAY_CONTEXT:-../../gateway}` picks
# it up — repoint it here (or in your environment) if your checkout lives
# elsewhere. Keep the default RELATIVE: the compose file has to stay portable.
export GATEWAY_CONTEXT ?= ../../gateway

# The tenant-side handover tool (provider/tools/grant, TOON_Network #59) that
# scripts/handover.mjs runs. It lives in the provider checkout — the same one
# the provider images build from — and is run from there rather than vendored,
# so the sandbox seals exactly the bytes the tool's own tests prove.
# `make setup` installs its dependencies when the checkout is present.
export PROVIDER_CONTEXT ?= ../../provider

# The anvil service bind-mounts the connector sibling's Foundry project
# READ-WRITE and runs as the invoking user so forge's artifacts stay owned by
# the developer (vendored pattern from connector/docker-compose.yml).
export HOST_UID ?= $(shell id -u)
export HOST_GID ?= $(shell id -g)

.PHONY: setup up up-payments up-credentials up-hs up-gateway up-gateway-hs down clean smoke smoke-ario \
        smoke-toon smoke-payments smoke-credentials smoke-provider smoke-provider2 \
        smoke-directory smoke-eviction smoke-m1 smoke-m2 smoke-m3 smoke-m4 smoke-m5 smoke-m6 smoke-m7 smoke-ci smoke-hs hs-address \
        preflight-channel-state logs ps test require-store-context require-anytoon-context require-gateway-context

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
		echo "layer, use \`make up-payments\` + \`make smoke-payments\` instead;"; \
		echo "if you are buying Anyone credential bundles, \`make up-credentials\`"; \
		echo "+ \`make smoke-credentials\` need the anytoon checkout but not this one."; \
		exit 1; \
	fi
# Hard gate for the paths that BUILD the claim-minter image — `make up` and
# `make up-credentials`, like the store gate above. The payments profile never
# renders it.
require-anytoon-context:
	@if [ ! -f "$(ANYTOON_CONTEXT)/claim-minter/Dockerfile" ]; then \
		echo "ERROR: anytoon checkout not found at $(ANYTOON_CONTEXT)"; \
		echo "The sandbox builds the claim-minter image from a sibling checkout"; \
		echo "of the anytoon repo (it publishes no image). Clone it there, or"; \
		echo "set ANYTOON_CONTEXT to where your checkout lives:"; \
		echo "    make up ANYTOON_CONTEXT=/path/to/anytoon"; \
		echo; \
		echo "Only \`make up\` (full stack) and \`make up-credentials\` need it."; \
		echo "If you are working on the payment layer alone, use"; \
		echo "\`make up-payments\` + \`make smoke-payments\` instead."; \
		exit 1; \
	fi

# Hard gate for the paths that BUILD the Workload Gateway image — `make
# up-gateway` and `make up-gateway-hs`. Nothing else renders it.
require-gateway-context:
	@if [ ! -f "$(GATEWAY_CONTEXT)/Dockerfile" ]; then \
		echo "ERROR: gateway checkout not found at $(GATEWAY_CONTEXT)"; \
		echo "The sandbox builds the Workload Gateway image from a sibling checkout"; \
		echo "of the gateway repo (toon-protocol/gateway; it publishes no image)."; \
		echo "Clone it there, or set GATEWAY_CONTEXT to where your checkout lives:"; \
		echo "    make up-gateway GATEWAY_CONTEXT=/path/to/gateway"; \
		echo; \
		echo "Only \`make up-gateway\` and \`make up-gateway-hs\` need it."; \
		exit 1; \
	fi

## one-time: install the script deps (needed by `make smoke` on the host).
## Deliberately does NOT require the store or anytoon checkouts — a
## payments-only developer must be able to run setup, up-payments and
## smoke-payments with no sibling checkout at all; `make up` is where those
## requirements are enforced.
setup:
	@if [ ! -f "$(STORE_CONTEXT)/Dockerfile.store" ]; then \
		echo "NOTE: no store checkout at $(STORE_CONTEXT)."; \
		echo "      Fine for \`make up-payments\` and \`make up-credentials\`;"; \
		echo "      \`make up\` (full stack) will stop and explain until it exists."; \
		echo; \
	fi
	@if [ ! -f "$(ANYTOON_CONTEXT)/claim-minter/Dockerfile" ]; then \
		echo "NOTE: no anytoon checkout at $(ANYTOON_CONTEXT)."; \
		echo "      Fine for \`make up-payments\` / \`make smoke-payments\`;"; \
		echo "      \`make up\` (full stack) and \`make up-credentials\` will stop"; \
		echo "      and explain until it exists."; \
		echo; \
	fi
	npm ci
	@if [ -f "$(PROVIDER_CONTEXT)/tools/grant/package.json" ]; then \
		echo; echo "installing the handover tool's deps in $(PROVIDER_CONTEXT)/tools/grant (scripts/handover.mjs runs it from there)"; \
		npm install --prefix "$(PROVIDER_CONTEXT)/tools/grant" --omit=dev --no-package-lock --no-audit --no-fund; \
	else \
		echo "NOTE: no provider checkout at $(PROVIDER_CONTEXT) — scripts/handover.mjs (the"; \
		echo "      Workload Gateway's tenant side) will stop and explain until it exists."; \
	fi

## start everything (chains + init jobs + gateway + bundler + TOON layer)
up: require-store-context require-anytoon-context
	$(COMPOSE) up -d --build

## start the PAYMENT LAYER ONLY: anvil + solana-validator + their seed jobs +
## the relay + the hub + the Solana channel-open job + BOTH compute providers,
## each with its own connector and its own directory publisher (13 services).
## No gateway, no bundler, no store, no gas station — and no store sibling
## checkout.
up-payments: COMPOSE_PROFILE = payments
up-payments:
	$(COMPOSE) up -d --build

## start the CREDENTIALS slice: the payment layer PLUS the paid side of the
## denomination boundary — the issuer path (issuer + minter + datastores + key
## job), the anytoon connector, and the swap driver that keeps the ANYONE TWAP
## fresh (without it the crossing refuses T00 within minutes). 15 services.
## Needs the anytoon sibling checkout (claim-minter builds from it) but NOT
## the store checkout — the whole point of the profile.
up-credentials: COMPOSE_PROFILE = credentials
up-credentials: require-anytoon-context
	$(COMPOSE) up -d --build

## OPT-IN, and it takes a THIRD-PARTY DEPENDENCY: `full` plus the hidden-service
## ingress. The anon daemon bootstraps against the REAL Anyone network (there is
## no local directory authority), generates this sandbox's `.anyone` address,
## and fronts the anytoon issuer path with it. Never folded into `make up`: a
## cold start that can go red because a relay network had a bad day is not a
## sandbox. Expect a minute or two of bootstrapping, more on a cold volume.
up-hs: require-store-context require-anytoon-context
	# Build EVERYTHING first, including the images `up` would otherwise build
	# later. A `--build` on the final `up` rebuilds the anon image, and a new
	# image id makes compose RECREATE those containers — throwing away the
	# circuits this target just spent two minutes waiting for, moments before
	# smoke-hs needs them. (anytoon's Makefile learned this the same way.)
	$(COMPOSE_HS) build
	# The image a HIDDEN lease's two sidecars run, pre-pulled. A hidden lease is
	# three containers (TOON_Network #41): `toon-<id>-egress`, which owns the
	# network namespace on `hs-egress` and sets the one route out;
	# `toon-<id>`, the workload itself, sharing that namespace; and
	# `toon-<id>-ingress`, which republishes the lease's ports on the host. The
	# first and last are this image, and without this line the FIRST hidden
	# spawn pays for the pull inside the tenant's lease. Pinned by digest in
	# provider/src/docker.rs (`HIDDEN_SIDECAR_IMAGE`) — keep the two in step.
	@docker pull -q alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc >/dev/null
	# The daemons FIRST and alone: the connector's config has to name an
	# address only the daemon can generate, so the daemon cannot wait for it.
	# THREE of them now — the hidden provider (TOON_Network #43) has one of its
	# own, and `hs-provider-ingress` comes with it because the daemon's config
	# names its pinned address.
	$(COMPOSE_HS) up -d anon anon-client hs-provider-ingress anon-hs
	@echo
	@echo "waiting for all three daemons to bootstrap against the REAL Anyone network."
	@echo "a minute or two is normal; a cold volume takes longer. Watch it with:"
	@echo "    docker compose --profile hs logs -f anon anon-client anon-hs"
	@echo
	@$(call wait_healthy,anon anon-client anon-hs)
	# The addresses, out of the daemons and into the configs that mount them.
	./scripts/hs-address.sh
	./scripts/hs-provider-address.sh
	# Now the rest of the stack, with the anytoon-connector recreated against
	# the rendered config so it PUBLISHES the .anyone endpoint. A client dials
	# what a node publishes, not what the caller typed. The hidden provider and
	# its connector mount their rendered configs for the same reason.
	ANYTOON_CONNECTOR_CONF=$(HS_CONNECTOR_CONF) \
	PROVIDER_HS_CONNECTOR_CONF=$(HS_PROVIDER_CONNECTOR_CONF) \
	PROVIDER_HS_CONF=$(HS_PROVIDER_CONF) \
	  $(COMPOSE_HS) up -d
	@echo "  re-checking the daemons, in case the rest of the stack disturbed them"
	@$(call wait_healthy,anon anon-client anon-hs)
	@echo
	@echo "up. \`make smoke-hs\` buys a bundle over the circuit."
	@echo
	@echo "NOTE: the anytoon node now advertises the CIRCUIT as its ingress, which is"
	@echo "the production shape being rehearsed — so \`make smoke\` no longer reaches it"
	@echo "directly on clearnet (its hub-routed leg is unaffected). Run \`make smoke\`"
	@echo "against \`make up\`; run \`make smoke-hs\` against this. See README §2 + §6.6."

## THE WORKLOAD GATEWAY (TOON_Network ADR 0013, spec §12; Milestones 5 and 6,
## #53 and #62): `full` PLUS the gateway and its own connector — two services,
## built from the gateway sibling checkout. `make up-gateway
## COMPOSE_PROFILE=payments` puts them on the payment layer instead (the two
## providers and the relay are all the gateway needs; no store checkout). Then
## a tenant spawns (`node scripts/spawn.mjs`), seals a Gateway Handover to the
## gateway's connector with `node scripts/handover.mjs <lease.json>` — NOTHING
## IS PUBLISHED on that path — and opens http://<canonical label>.gw.localhost:3280/;
## `node scripts/handover.mjs --withdraw <lease.json>` takes it off again.
## README §2, "The Workload Gateway", walks the whole path. The `hs` profile is
## NOT part of this: the hidden path is `make up-gateway-hs`, by hand.
up-gateway: require-gateway-context
	@if [ "$(COMPOSE_PROFILE)" = full ]; then $(MAKE) --no-print-directory require-store-context require-anytoon-context; fi
	$(COMPOSE_GW) up -d --build

## The gateway ON TOP OF `make up-hs` (run that first): the same two services
## plus the hidden provider's `status` rewrite, rendered at the address
## `anon-hs` generated (conf/.rendered/workload-gateway-hs.env, written by
## scripts/hs-provider-address.sh). Nothing else is touched — the rendered
## configs `up-hs` mounted are passed again so compose has no reason to
## recreate the anytoon or hidden-provider containers and lose their circuits.
## The recipe that uses it is README §2, "Reaching a hidden workload by hand".
up-gateway-hs: require-gateway-context
	@if [ ! -f "$(HS_PROVIDER_CONF)" ]; then \
		echo "ERROR: $(HS_PROVIDER_CONF) is not rendered — run \`make up-hs\` first."; exit 1; \
	fi
	./scripts/hs-provider-address.sh
	ANYTOON_CONNECTOR_CONF=$(HS_CONNECTOR_CONF) \
	PROVIDER_HS_CONNECTOR_CONF=$(HS_PROVIDER_CONNECTOR_CONF) \
	PROVIDER_HS_CONF=$(HS_PROVIDER_CONF) \
	  $(COMPOSE_HS) --profile gateway up -d --build workload-gateway workload-gateway-connector

## print this sandbox's TWO `.anyone` addresses — the anytoon issuer path's and
## the HIDDEN PROVIDER's — re-rendering the three configs that name them.
hs-address:
	./scripts/hs-address.sh
	./scripts/hs-provider-address.sh

# Waits until the named services report docker-healthy. `anon`'s healthcheck is
# "hostname file exists AND Bootstrapped 100%", so this is a wait for a CIRCUIT,
# not for a container: one that is merely Up has neither. Vendored from
# anytoon's Makefile.
define wait_healthy
	for svc in $(1); do \
		n=0; \
		while :; do \
			cid=$$($(COMPOSE_HS) ps -q $$svc 2>/dev/null); \
			if [ -n "$$cid" ] && \
			   [ "$$(docker inspect -f '{{.State.Health.Status}}' $$cid 2>/dev/null)" = healthy ]; then \
				echo "  $$svc: healthy"; break; \
			fi; \
			n=$$((n+1)); \
			if [ $$n -gt 60 ]; then \
				echo; \
				echo "  $$svc never became healthy after ~5 minutes."; \
				echo "  This is USUALLY the Anyone network rather than this sandbox:"; \
				echo "  the daemon has to reach real directory authorities and real"; \
				echo "  relays. Look at what it says before assuming a config fault:"; \
				echo "      docker compose --profile hs logs --tail 80 $$svc"; \
				echo "  A container that exited at once instead is a CONFIG fault —"; \
				echo "  check conf/anonrc (AgreeToTerms 1, an explicit Nickname)."; \
				exit 1; \
			fi; \
			sleep 5; \
		done; \
	done
endef

## stop the stack (keeps state: gateway sqlite, localstack S3, postgres).
## Sweeps every profile: the hidden-service key volume survives (that is what
## `-v` in `clean` is for), but no daemon is left running.
down:
	$(COMPOSE_ALL) down

## stop the stack and wipe ALL local state (next `make up` is a cold start).
## `-v` also removes the connectors' claim-journal volumes — load-bearing: a
## journal left behind pairs a live replay watermark with a wiped chain and
## satisfies the next smoke's payment assertion without it having paid.
## Some services run as root and leave root-owned files in ./data, so the
## wipe happens inside a throwaway container rather than needing sudo.
## `-v` also takes the anon-data volume, i.e. THIS SANDBOX'S HIDDEN-SERVICE KEY
## and address. That is deliberate and documented: here the address is
## disposable operational state, and the next `make up-hs` publishes a new one.
## In a deployment the same wipe would strand every buyer's configuration.
clean:
	$(COMPOSE_ALL) down -v --remove-orphans
	rm -rf .toon-client conf/.rendered
	@if [ -d data ]; then \
		docker run --rm -v "$$(pwd)/data:/wipe" alpine:3.20 sh -c 'rm -rf /wipe/* /wipe/.[!.]* /wipe/..?*' 2>/dev/null; \
		rmdir data; \
	fi

## THE CHANNEL-STATE PREFLIGHT (TOON_Network #74, M7-6): compares every
## RUNNING directory publisher's local channel store (channels.json on its own
## volume) against relay-connector's own claim journal, and fails AT ONCE — by
## name, with both amounts and the remedy — on the drift README §8 documents,
## where a publisher's store has fallen STRICTLY BEHIND the connector's own
## watermark (equal is the normal resting state between two writes) and every
## claim it signs from there advances value by 0. A prerequisite of every
## RELAY-WRITING smoke below (smoke-provider, smoke-provider2,
## smoke-directory, smoke-eviction, smoke-ci, smoke-m1 through smoke-m7) so
## the drift is caught before a lease is bought rather than several steps
## into one. Safe
## to run on its own, against a stack that is not up (it then finds nothing
## to compare and exits 0) or mid-session (`make preflight-channel-state`).
preflight-channel-state:
	node scripts/preflight-channel-state.mjs

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

## credentials proof for `make up-credentials`: the payments assertions PLUS
## the denomination boundary end to end — the price triple asserted, the
## ANYONE rate live off the swap driver's market, the free key document, the
## scoped free route, the unpaid refusal, and one PAID hub-routed bundle
## purchase converted uUSDC -> ANYONE at the live TWAP, with both sides'
## books asserted in their own units and the rate required to have MOVED.
## No store, gateway, bundler or gas-station assertions.
smoke-credentials:
	TOON_SMOKE_CREDENTIALS_ONLY=1 node scripts/smoke-toon.mjs

## compute-provider proof for `make up-payments` (or `make up`): a tenant
## opens a Solana mock-USDC channel against the hub, signs a Lease Request
## with a fresh Nostr key, pays g.toon.provider.basic.v1.spawn through the
## hub (sealed to the provider's own connector), and the answer names a
## container that is running on the host and reachable over SSH with the
## tenant's key; both connectors' books grow by their prices, and a replay
## of the same request is refused (and still billed). The workload is left
## to expire (conf/provider.toml lease_interval_s) unless the script removes
## it — see TOON_SMOKE_KEEP_WORKLOAD in scripts/smoke-provider.mjs.
smoke-provider: preflight-channel-state
	node scripts/smoke-provider.mjs

## THE SAME SMOKE, AGAINST THE SECOND PROVIDER (TOON_Network #34): the same
## script, the same helpers, one provider argument. It proves the second
## provider is a provider in its own right and not a copy sharing the first's
## surfaces — a tenant seals to provider2-connector's own edge (:3250), pays
## g.toon.provider2.basic.v1.spawn through the hub, reaches the workload over
## SSH on a port out of the second provider's own range, and the money lands
## in the second peering's own channel. Buys the 180 s `basic` tier, so a run
## left half-finished frees its slot in three minutes.
smoke-provider2: preflight-channel-state
	TOON_SMOKE_PROVIDER=provider2 node scripts/smoke-provider.mjs

## provider-directory proof for `make up-payments` (or `make up`): the
## provider's Profile, its Listing and its Liveness are read back off the
## sandbox relay at :7100 by author and #L, the Listing is filterable by its
## #l isolation and arch labels (the RELAY does the search, not the tenant),
## Liveness carries an expiration five cadences out and is REPLACED rather
## than accumulated on the next cadence, and every write was a PAID
## g.toon.relay packet on the directory publisher's own Solana channel —
## never the free g.toon.relay.ephemeral lane. It waits out one cadence
## (conf/provider.toml liveness_cadence_s), so it takes about a minute.
smoke-directory: preflight-channel-state
	node scripts/smoke-directory.mjs

## eviction proof for `make up-payments` (or `make up`): a tenant pays for its
## own lease, `docker compose exec provider toon-provider evict ...` stops it
## through the provider's loopback-only operator endpoint (never a published
## port), the container is gone, the free status route reports
## `Ended(eviction)`, and a signed Eviction Notice naming the workload id and
## reason is readable on the sandbox relay. The lease is always evicted
## before the script exits, so — unlike smoke-provider's raw `docker rm -f` —
## it never leaves a lease running for smoke-directory to count.
smoke-eviction: preflight-channel-state
	node scripts/smoke-eviction.mjs

## MILESTONE 1 ACCEPTANCE TEST (TOON_Network #1 / #9) for `make up-payments`
## (or `make up`): the whole lease lifecycle, twice. Per run: Profile,
## Listings and an unexpired Liveness read back off the relay; the free
## availability route end to end (0 arrives, the provider's book does not
## move); a paid spawn to a running, SSH-reachable workload; a paid extend
## that grows expires_at by exactly one Lease Interval; status; the sweep
## destroying the workload at expiry and status reporting ended by expiry;
## Liveness counting the lease and recovering; and every claim book grown by
## exactly the route prices. Once paying THROUGH THE HUB (client channel
## against :3200, sealed to the provider connector, hub client book + provider
## peer book asserted) and once paying the PROVIDER CONNECTOR DIRECTLY (client
## channel against :3240, no fee, its client book asserted) — then the two
## runs' answer shapes and lifecycles are compared. Buys the sandbox-only
## `smoke` listing (conf/provider.toml, 30 s Lease Interval); three to four
## minutes. TOON_M1_LISTING=basic runs it on the three-minute tier instead.
smoke-m1: preflight-channel-state
	node scripts/smoke-milestone1.mjs

## Milestone 2's acceptance test (TOON_Network #10, scripts/smoke-milestone2.mjs):
## the TOON-native image path end to end. Publishes a two-layer image built
## here (base layer upstream, the rest as parts in the TOON store) and a
## Template for it, expands the Template tenant-side and pays a spawn with
## { digest, registry_entry } and no reference, then an all-store image
## spawned by { digest } alone, twice (the second from the provider's cache);
## reads every entry, Blob Record and part back from the relay and the
## gateway; closes the store, relay and provider books to the unit. Needs the
## FULL stack (`make up`): the store and the gateway. Buys the `smoke`
## listing; about two minutes.
smoke-m2: preflight-channel-state
	node scripts/smoke-milestone2.mjs

## MILESTONE 3 ACCEPTANCE TEST (TOON_Network #11 / #35, scripts/smoke-milestone3.mjs)
## for `make up-payments` (or `make up`): Warm Standby end to end, across BOTH
## providers. One signed spawn with `standby_set` [provider, provider2] is
## paid on the first provider's g.toon.provider.warm.v1.spawn (the PRIMARY:
## role primary, access, a running SSH-reachable workload in its id range)
## and on the second's g.toon.provider2.warm.v1.standby at standby_price (the
## WARM STANDBY: role standby, no access, a slot its Liveness counts); the
## reservation is paid on .standby.extend and refuses .extend (not_running).
## Then `docker compose stop provider`: the standby watches the primary's
## Liveness expire, announces a Takeover (kind 30433, d = the workload id)
## on the relay, settles two cadences later and starts the workload in ITS
## OWN id range (toon-11xx), reachable with the tenant's key; .extend at
## full price succeeds and .standby.extend is not_standby. `docker compose
## start provider`: the primary finds the Takeover, stops its copy (status
## `stopped`) and exactly one copy runs on the host. Every book is closed to
## the unit — standby_price per reservation interval, full price for the
## spawn and the post-Takeover extension, the two billed refusals, and ONE
## g.toon.relay unit for the Takeover on directory-publisher2's channel —
## and both leases are ended by the tenant. Buys the 600 s `warm` tier on
## both providers; five to six minutes, four of them the takeover timeline
## (conf/provider2.toml says why). It stops and restarts the FIRST provider's
## container, so nothing else should be spawning on it meanwhile.
## TOON_M3_STANDBY_ONLY=1 runs the reservation side against provider2 alone
## — for a first provider that does not sell `warm` — and says in its
## verdict that it is not a pass.
smoke-m3: preflight-channel-state
	node scripts/smoke-milestone3.mjs

## The `ci` listing (TOON_Network #14; spec §4.4 and Appendix A.1,
## scripts/smoke-ci.mjs) for `make up-payments` (or `make up`): the `ci`
## Listing on the relay carries ["t","docker"] and A.1's content; a tenant
## pays g.toon.provider.ci.v1.spawn through the hub; on the host daemon the
## workload runs unprivileged beside the provider's privileged `toon-<id>-dind`
## sidecar, both under the lease's cgroup slice carrying the tier's limits;
## over SSH, as the tenant, /var/run/docker.sock answers, is NOT the host's
## daemon, pulls hello-world and runs it; the books grow by the tier's price;
## a terminate bearing the lease's token removes the workload, the sidecar,
## its volumes, its network and its slice. Pre-pulls the dind image so the
## spawn does not pay for it. About a minute.
smoke-ci: preflight-channel-state
	@docker pull -q $$(node -e "process.stdout.write(require('fs').readFileSync('scripts/smoke-ci.mjs','utf8').match(/DIND_IMAGE = '([^']+)'/)[1])") >/dev/null
	node scripts/smoke-ci.mjs

## Unit tests for the host-side tooling (today: the publisher,
## scripts/publisher/, TOON_Network Milestone 2) against in-memory fakes —
## no stack needed. The publisher itself runs against `make up`:
##   node scripts/publisher.mjs blob <file> --key <hex>
test:
	npm test

## hidden-service proof for `make up-hs`: a client dials this sandbox's
## `.anyone` address through the SOCKS5h proxy — chain RPC on the same circuit,
## which is the client's default — and buys one real bundle of blind signatures
## from the issuer. A REHEARSAL, NOT A GATE: it can fail because the Anyone
## network had a bad day, and it says which side failed in those words. Exit 75
## (EX_TEMPFAIL) means network-side; exit 1 means this sandbox.
smoke-hs:
	node scripts/smoke-hs.mjs

## MILESTONE 4 ACCEPTANCE TEST (TOON_Network #12 / #44, scripts/smoke-milestone4.mjs)
## for `make up-hs` ONLY — it dials the REAL Anyone network, and like
## `smoke-hs` it is a rehearsal with two verdicts, not a gate: exit 1 is this
## sandbox, exit 75 (EX_TEMPFAIL) is the overlay not carrying. The hidden
## provider end to end: its Profile on the relay says `hidden: true` with no
## `host` and an `.anyone` connector_url, every Listing carries `hidden:true`
## and the two public providers' carry none; a buyer with only that address
## and the SOCKS proxy (account index 6, minting its own mock USDC over the
## circuit) opens an EVM channel against the hidden connector and pays a
## spawn there — no hub in the path; the answer's access.host is a PER-LEASE
## `.anyone` address and no IP appears anywhere; on the host the lease is
## three containers on the anon egress network in the 1200-1299 range and
## anon-hs holds the address as a detached service; SSH to that address
## through the proxy (an `nc -X 5` ProxyCommand) with the tenant's key, the
## published port answering at the same address; from inside, a what-is-my-IP
## service sees an exit and not this host, and a dial to the host at
## anon.forward_host carries nothing back; terminate drops the address from
## the daemon, the address stops answering, no `toon-<id>*` container
## remains, Liveness recovers; the hidden connector's book grew by exactly the
## listing price, on the sandbox chains (the private-RPC gate is asserted in
## preflight). Buys the 180 s `basic` tier (a fresh descriptor is the slow
## part); two to three minutes. TOON_M4_LISTING overrides the tier.
smoke-m4: preflight-channel-state
	node scripts/smoke-milestone4.mjs

## MILESTONE 5 ACCEPTANCE TEST (TOON_Network #46 / #54, scripts/smoke-milestone5.mjs)
## for `make up-gateway` (or `make up-gateway COMPOSE_PROFILE=payments`): the
## WORKLOAD GATEWAY end to end — a workload has a stable URL that survives a
## Takeover with no tenant online. That promise is Milestone 5's and is
## unchanged; the tenant path underneath it is Milestone 6's (#56, #63). The
## gateway's own connector terminates exactly ONE route and it is free, and an
## unknown hostname is answered `no_grant` by the gateway itself. A tenant
## spawns `traefik/whoami` on container port 80 across a two-member Standby Set
## (the `make smoke-m3` shape, with ports) — one content, one request per
## member, each bearing that member's own Continuation Token — SEALS ONE Gateway
## Handover to the gateway's connector with `node scripts/handover.mjs`
## (nothing is published: the smoke asserts the relay holds no event naming the
## workload) and stops there. Both the canonical hostname (the 52-character
## base32 of the workload id) and the handover's name then answer with the
## workload's OWN body over HTTP and HTTPS, `Host` preserved and the §12.5
## forwarding headers set. `docker compose stop provider`: the standby
## announces a Takeover, settles and starts the workload, and THE SAME TWO URLS
## come back answered by the copy on the STANDBY — whoami names its own
## container, so the move is visible in the response body and in no log. The
## restarted primary stands down; `terminate` leaves both URLs answering 503
## `no_running_member` in the spec's error shape; and neither provider's book
## grew by a unit for anything the gateway asked, because `status` is free and a
## gateway calls no other route. Buys the 600 s `warm` tier on both providers;
## six to seven minutes, four of them the takeover timeline. It stops and
## restarts the FIRST provider's container, so nothing else should be spawning
## on it meanwhile.
smoke-m5: preflight-channel-state
	node scripts/smoke-milestone5.mjs

## MILESTONE 6 ACCEPTANCE TEST (TOON_Network #56 / #63, scripts/smoke-milestone6.mjs)
## for `make up-gateway` (or `make up-gateway COMPOSE_PROFILE=payments`): the
## whole path a tenant walks — pay, spawn, poll, delegate, front, withdraw,
## terminate — WITHOUT SIGNING ANYTHING AND WITHOUT PUBLISHING ANYTHING, with
## each step asserting that what the milestone removed is really gone rather
## than merely unused. A paid spawn bearing the Continuation Token derived for
## the provider starts a workload and `status` with that token answers; a wrong
## token and an absent one are both `not_tenant`, a replayed `request_id` is
## `stale_request`, and a request naming the other provider is
## `invalid_request` — and the lease is untouched by all four. The provider's
## container is then STOPPED (the workload goes on running) and STARTED, and
## the same token still reads and still ends the lease: a restart does not
## orphan a paid workload. `node scripts/handover.mjs` seals a Gateway Handover
## to the gateway's connector and a `curl` of the canonical hostname reaches
## the workload's own body; a DELEGATED `status` is answered byte for byte what
## the tenant is answered, an expired grant is `bad_grant`, and a delegated
## `terminate` is refused both ways it can be sent; a Gateway Withdrawal takes
## the workload off and the same `curl` answers the gateway's own `no_grant`.
## Then a Standby Set across both providers — one content, one request per
## member — and THE REGRESSION per-provider derivation exists to prevent: a
## request bearing the primary's token is refused `not_tenant` at the standby,
## on `status` and on `terminate`, while the standby's own token reads it fine.
## Finally the relay is swept across the whole namespace: no event signed by a
## key this run's tenants held, none of kind 4432 or 30438, none naming either
## workload id, and every author a provider or a publisher — the sweep having
## first been run against a FABRICATED relay carrying exactly those events and
## shown to catch them, so that finding nothing means something. Buys the 600 s
## `warm` tier twice on the first provider (one lease at a time) and once as a
## standby on the second; two to three minutes. It stops and restarts the FIRST
## provider's container, so nothing else should be spawning on it meanwhile.
smoke-m6: preflight-channel-state
	node scripts/smoke-milestone6.mjs

## MILESTONE 7 ACCEPTANCE TEST (TOON_Network #69 / #76, scripts/smoke-milestone7.mjs)
## for `make up-gateway` — the FULL stack plus the gateway, because the paged
## image lives in the store: a tenant REVOKES a Workload Gateway's reading
## before the grant runs out, and serves from an image too large for one Blob
## Record. `node scripts/spawn.mjs` forms a two-member Standby Set and `node
## scripts/handover.mjs` hands it to the gateway, which serves the canonical
## hostname; a delegated `status` with each member's grant is answered.
## `node scripts/rotate.mjs` rotates both members: on the wire the old grant
## is `bad_grant` and the old token `not_tenant` at each, the new token reads,
## and the gateway — told nothing — answers 503 `member_unreachable` naming
## both members' `bad_grant` within a cadence or two, while the workload runs
## on. The same handover command again seals grants of the ROTATED tokens (re-
## derived and matched), is admitted, and the hostname serves again; the lease
## ends with the new token. Then an image — busybox plus a 2 MiB random layer —
## is published with the publisher's record ceiling LOWERED (`--record-max`,
## rather than storing 70 MB) so the layer's Blob Record PAGES: read from the
## relay and from its store copy it carries `pages` and no `parts`, every page
## hashes and counts at the gateway's /raw/, and `blob-verify`/`image-verify`
## read it through its pages; `availability` says would_run and a paid `smoke`
## spawn runs it by digest. Buys `warm` with a standby, then `smoke` once;
## two to three minutes, most of it the gateway's cadence and the uploads.
smoke-m7: preflight-channel-state
	node scripts/smoke-milestone7.mjs

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps -a
