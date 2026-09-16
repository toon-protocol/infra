# TOON Protocol local dev sandbox. See README.md for the full guide.

# Every service in docker-compose.yml carries a profile, so a profile is always
# selected here (see the "Profiles" block at the top of that file).
#   full         the whole stack, every service — the sandbox's default
#   payments     chains + hub + seed/open jobs only, no sibling app checkout
#                needed beyond the connector's
#   credentials  `payments` PLUS the Anyone credentials issuer path and the
#                swap driver — the denomination boundary without the permaweb
#                half. Needs the anytoon checkout, NOT the store one
#   hs           `full` PLUS the anon daemon, its forwarder and the buyer's
#                SOCKS proxy — OPT-IN (`make up-hs`), never part of `up`/`smoke`
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

# down/clean must sweep EVERY profile's containers, whichever one brought them
# up — otherwise `make up-hs && make down` leaves three daemons running.
COMPOSE_ALL = docker compose --profile full --profile payments --profile credentials --profile hs

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

# The anvil service bind-mounts the connector sibling's Foundry project
# READ-WRITE and runs as the invoking user so forge's artifacts stay owned by
# the developer (vendored pattern from connector/docker-compose.yml).
export HOST_UID ?= $(shell id -u)
export HOST_GID ?= $(shell id -g)

.PHONY: setup up up-payments up-credentials up-hs down clean smoke smoke-ario \
        smoke-toon smoke-payments smoke-credentials smoke-provider smoke-provider2 \
        smoke-directory smoke-eviction smoke-m1 smoke-m2 smoke-m3 smoke-ci smoke-hs hs-address \
        logs ps test require-store-context require-anytoon-context

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
	# The daemons FIRST and alone: the connector's config has to name an
	# address only the daemon can generate, so the daemon cannot wait for it.
	$(COMPOSE_HS) up -d anon anon-client
	@echo
	@echo "waiting for both daemons to bootstrap against the REAL Anyone network."
	@echo "a minute or two is normal; a cold volume takes longer. Watch it with:"
	@echo "    docker compose --profile hs logs -f anon anon-client"
	@echo
	@$(call wait_healthy,anon anon-client)
	# The address, out of the daemon and into the config the connector mounts.
	./scripts/hs-address.sh
	# Now the rest of the stack, with the anytoon-connector recreated against
	# the rendered config so it PUBLISHES the .anyone endpoint. A client dials
	# what a node publishes, not what the caller typed.
	ANYTOON_CONNECTOR_CONF=$(HS_CONNECTOR_CONF) $(COMPOSE_HS) up -d
	@echo "  re-checking the daemons, in case the rest of the stack disturbed them"
	@$(call wait_healthy,anon anon-client)
	@echo
	@echo "up. \`make smoke-hs\` buys a bundle over the circuit."
	@echo
	@echo "NOTE: the anytoon node now advertises the CIRCUIT as its ingress, which is"
	@echo "the production shape being rehearsed — so \`make smoke\` no longer reaches it"
	@echo "directly on clearnet (its hub-routed leg is unaffected). Run \`make smoke\`"
	@echo "against \`make up\`; run \`make smoke-hs\` against this. See README §2 + §6.6."

## print this sandbox's `.anyone` address (re-renders the connector config).
hs-address:
	./scripts/hs-address.sh

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
smoke-provider:
	node scripts/smoke-provider.mjs

## THE SAME SMOKE, AGAINST THE SECOND PROVIDER (TOON_Network #34): the same
## script, the same helpers, one provider argument. It proves the second
## provider is a provider in its own right and not a copy sharing the first's
## surfaces — a tenant seals to provider2-connector's own edge (:3250), pays
## g.toon.provider2.basic.v1.spawn through the hub, reaches the workload over
## SSH on a port out of the second provider's own range, and the money lands
## in the second peering's own channel. Buys the 180 s `basic` tier, so a run
## left half-finished frees its slot in three minutes.
smoke-provider2:
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
smoke-directory:
	node scripts/smoke-directory.mjs

## eviction proof for `make up-payments` (or `make up`): a tenant pays for its
## own lease, `docker compose exec provider toon-provider evict ...` stops it
## through the provider's loopback-only operator endpoint (never a published
## port), the container is gone, the free status route reports
## `Ended(eviction)`, and a signed Eviction Notice naming the workload id and
## reason is readable on the sandbox relay. The lease is always evicted
## before the script exits, so — unlike smoke-provider's raw `docker rm -f` —
## it never leaves a lease running for smoke-directory to count.
smoke-eviction:
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
smoke-m1:
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
smoke-m2:
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
smoke-m3:
	node scripts/smoke-milestone3.mjs

## The `ci` listing (TOON_Network #14; spec §4.4 and Appendix A.1,
## scripts/smoke-ci.mjs) for `make up-payments` (or `make up`): the `ci`
## Listing on the relay carries ["t","docker"] and A.1's content; a tenant
## pays g.toon.provider.ci.v1.spawn through the hub; on the host daemon the
## workload runs unprivileged beside the provider's privileged `toon-<id>-dind`
## sidecar, both under the lease's cgroup slice carrying the tier's limits;
## over SSH, as the tenant, /var/run/docker.sock answers, is NOT the host's
## daemon, pulls hello-world and runs it; the books grow by the tier's price;
## a tenant-signed terminate removes the workload, the sidecar, its volumes,
## its network and its slice. Pre-pulls the dind image so the spawn does not
## pay for it. About a minute.
smoke-ci:
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

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps -a
