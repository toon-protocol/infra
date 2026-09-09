#!/usr/bin/env bash
# PROTOTYPE — seed one fake head block into core's SQLite so the gateway's
# GraphQL `blocks(first: 1)` returns a height. The Turbo upload service refuses
# to sign receipts ("Unable to sign receipt... Failed to fetch block info")
# until the gateway GraphQL reports a current block; on a chainless local
# gateway there is none, so we fake height 1. Run once after the gateway stack
# is up (idempotent).
set -euo pipefail
docker exec proto-gateway-upload-core-1 /nodejs/bin/node -e "
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/sqlite/core.db');
db.prepare(\"INSERT OR REPLACE INTO new_blocks (indep_hash, height, previous_block, nonce, hash, block_timestamp, diff, cumulative_diff, last_retarget, reward_addr, reward_pool, block_size, weave_size, tx_count, missing_tx_count) VALUES (?, 1, ?, ?, ?, ?, '1', '0', 0, ?, '0', 0, 0, 0, 0)\").run(Buffer.alloc(48,7), Buffer.alloc(48,8), Buffer.alloc(8,1), Buffer.alloc(32,2), Math.floor(Date.now()/1000), Buffer.alloc(32,3));
console.log('seeded head block:', db.prepare('SELECT height, block_timestamp FROM new_blocks').all());
db.close();
"
curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"{ blocks(first: 1) { edges { node { height timestamp } } } }"}'
echo
