#!/usr/bin/env node
// The channel-state preflight (TOON_Network #74, M7-6): `make preflight-channel-state`,
// and a prerequisite of every relay-writing smoke (sandbox/Makefile —
// smoke-provider, smoke-provider2, smoke-directory, smoke-eviction, smoke-ci
// and smoke-m1 through smoke-m6; a future `make smoke-m7`, M7-7, can depend on
// it the same way).
//
// Compares every RUNNING directory publisher's local channel store
// (channels.json on its own volume) against relay-connector's own claim
// journal (`GET /claims`) for the same channel. A publisher's store fallen
// STRICTLY BEHIND the connector's own watermark is the channel-state drift
// README §8 documents: every claim it signs from there advances value by ZERO
// (relay-connector prices every directory write at 1) and the relay refuses
// every write from it, silently — its Profile, Listings and Liveness all go
// stale on the relay, and a smoke that reads them used to fail refused,
// hundreds of seconds and one purchase later, on a symptom that named nothing
// (seen on `directory-publisher-hs` at the end of Milestone 6, store at 70
// against a journal at 71). This fails BEFORE any lease is bought, BY NAME,
// with both amounts and the remedy.
//
// STORE == JOURNAL IS HEALTHY, not a mismatch: the client library persists a
// claim's advance to the store before the claim is even sent, so that is the
// ordinary resting state between two writes (lib/provider-smoke.mjs's
// `channelStateMismatch` says why in full).
//
// A publisher that is not running, or holds no channel yet (a fresh
// `make up`/`make up-hs`: nothing has been opened), is skipped — nothing to
// compare, and a stack that is not up at all exits 0 having checked none.
//
//   exit 0   every running publisher's store is level with or ahead of its
//            journal (or none is running)
//   exit 1   at least one has drifted BEHIND; the message names which, both
//            amounts and the remedy
import { channelStateReport, channelStateRemedy } from './lib/provider-smoke.mjs';

console.log('\x1b[1mpreflight-channel-state\x1b[0m — every directory publisher\'s local channel store vs relay-connector\'s own claim journal');

const report = await channelStateReport();
if (report.length === 0) {
  console.log('  nothing running holds a channel against relay-connector yet — nothing to compare.');
  process.exit(0);
}

let failed = false;
for (const r of report) {
  if (r.store < r.journal) {
    failed = true;
    console.error(`  \x1b[31mFAIL\x1b[0m ${r.service}: local channel store cumulativeAmount ${r.store} on ${r.channelKey}, `
      + `relay-connector's claim journal already at ${r.journal}.`);
    console.error(`       Every claim ${r.service} signs from here advances value by 0 and the relay refuses every write.`);
    console.error(`       Remedy: ${channelStateRemedy(r.service)}`);
  } else {
    console.log(`  \x1b[32mok\x1b[0m   ${r.service}: store ${r.store} >= relay-connector's journal ${r.journal} on ${r.channelKey}`);
  }
}

if (failed) {
  console.error('\n\x1b[31mpreflight-channel-state FAILED\x1b[0m — fix the drift above before running any smoke that writes to the relay.');
  process.exit(1);
}
console.log(`\n\x1b[32mpreflight-channel-state OK\x1b[0m: ${report.length} directory publisher(s) checked, none behind its journal.`);
