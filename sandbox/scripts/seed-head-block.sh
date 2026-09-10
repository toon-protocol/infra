#!/bin/sh
# Seeds one fake head block (height 1) into the gateway core's SQLite so the
# Turbo upload service can sign receipts: it resolves the current block
# height via the gateway's GraphQL `blocks(first: 1)` (fallback
# GET /block/current) to compute receipt deadlineHeight; on a chainless
# gateway both fail and every upload gets HTTP 503 "Unable to sign
# receipt... Failed to fetch block info". No service env or SDK option
# bypasses it.
#
# Runs INSIDE the ar-io-core image (which ships /nodejs/bin/node and
# better-sqlite3) as the `seed-gateway-block` one-shot compose service, with
# core's sqlite dir bind-mounted. Idempotent: INSERT OR REPLACE of the same
# height-1 row. Runs after core is healthy, so the schema exists.
set -eu

exec /nodejs/bin/node -e "
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/sqlite/core.db');
db.prepare(\"INSERT OR REPLACE INTO new_blocks (indep_hash, height, previous_block, nonce, hash, block_timestamp, diff, cumulative_diff, last_retarget, reward_addr, reward_pool, block_size, weave_size, tx_count, missing_tx_count) VALUES (?, 1, ?, ?, ?, ?, '1', '0', 0, ?, '0', 0, 0, 0, 0)\").run(Buffer.alloc(48,7), Buffer.alloc(48,8), Buffer.alloc(8,1), Buffer.alloc(32,2), Math.floor(Date.now()/1000), Buffer.alloc(32,3));
console.log('[seed-gateway-block] seeded head block:', JSON.stringify(db.prepare('SELECT height, block_timestamp FROM new_blocks').all()));
db.close();
"
