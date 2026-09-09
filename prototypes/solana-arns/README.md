PROTOTYPE — throwaway; answers: can local ArNS buy/ANT spawn work in Docker?

# solana-arns prototype

**Answer: YES, end-to-end.** A plain `solana-test-validator` in Docker, with
AR.IO's five Anchor programs + Metaplex Core preloaded at genesis, supports
the full `@ar.io/sdk` v4 flow: quote → spawn ANT → buy ArNS name → sync
attributes → set ANT target → read everything back. See `VERDICT.md` for the
full findings.

## How to run

```sh
# one-time (already done in this checkout; regenerates keys + the 2MB
# NameRegistry genesis account if keys/ or genesis/ are missing):
npm install
node gen-genesis.mjs        # if you regenerate keys, update the two pubkeys in docker-compose.yml

docker compose -p proto-solana-arns up -d
# RPC comes up in ~10s (clean-run measured; give the healthcheck ~30s headroom); then:
node seed.mjs               # mint local ARIO, init ario-arns + ario-core, fund buyer
node buy-name.mjs           # spawn ANT + buy a random lease name + set target
node buy-name.mjs my-name   # or pick the name

docker compose -p proto-solana-arns down
```

## What's here

| file | role |
|---|---|
| `docker-compose.yml` | validator (`ghcr.io/beeman/solana-test-validator`, agave 4.1.1, frozen since 2026-07-06) with 5 AR.IO programs via `--upgradeable-program`, mpl_core via `--bpf-program`, NameRegistry via `--account` |
| `gen-genesis.mjs` | generates `keys/admin.json`, `keys/treasury.json`, `genesis/name-registry.json` |
| `seed.mjs` | post-boot state seeding (ARIO mint, ATAs, `ario_arns::initialize`, `ario_core::initialize`) |
| `buy-name.mjs` | the SDK driver: spawn + buy + sync + setRecord + reads |
| `artifacts/*.so` | five programs dumped from devnet (staging ids) + committed `mpl_core.so` fixture |
| `ar-io-solana-contracts/` | shallow clone of the upstream repo (reference only; nothing built from it except the mpl_core fixture) |
| `keys/` | throwaway committed keypairs: admin = upgrade authority + protocol authority + buyer; treasury = treasury ATA owner |
| `VERDICT.md` | the actual findings: ids, seeding steps, gotchas |

Ports: 8899 (RPC), 8900 (WS). Compose project: `proto-solana-arns`.
