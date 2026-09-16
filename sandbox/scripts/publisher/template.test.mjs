// The Template publisher (TOON_Network #25), driven through the same one
// seam as the blob and image publishers: the paid `io` it is handed. Nothing
// here touches the network or a relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { publishTemplate, templateEventTemplate, K_TEMPLATE, TOON_LABEL } from './template.mjs';
import { templateFromEvent, expandTemplate } from '../lib/template.mjs';

const PUBLISHER = '2c0b7cf95324a07d05398b240174dc0c2be444d96b159aa6c7f7b1e668680991';

/**
 * The values of the M2-1 wire fixture, TOON_Network
 * docs/spec/fixtures/wire/registry.template.json (issue #19) — the
 * independent statement of the shape a Template has.
 */
const FIXTURE_CONTENT = {
  version: 1,
  image: {
    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    registry_entry: { address: `30434:${PUBLISHER}:web:1.0`, relay: 'ws://relay.fixture.example:7100' },
  },
  ports: [{ container_port: 8080, protocol: 'tcp' }],
  data_path: '/data',
  env_fixed: { MODE: 'production' },
  env_tenant: ['SITE_TITLE'],
  min_resources: { cpu_millicores: 500, memory_mb: 256, storage_gb: 4 },
};
/** That fixture's `event.content`, verbatim: the serialization, key order included. */
const FIXTURE_JSON =
  '{"version":1,"image":{"digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",' +
  `"registry_entry":{"address":"30434:${PUBLISHER}:web:1.0","relay":"ws://relay.fixture.example:7100"}},` +
  '"ports":[{"container_port":8080,"protocol":"tcp"}],"data_path":"/data","env_fixed":{"MODE":"production"},' +
  '"env_tenant":["SITE_TITLE"],"min_resources":{"cpu_millicores":500,"memory_mb":256,"storage_gb":4}}';

/** In-memory relay: every publish is journaled. */
const fakeIo = () => {
  const published = [];
  return { published, relay: { async publish(event) { published.push(event); } } };
};

test('a Template serializes exactly as the M2-1 `registry.template` wire fixture does', () => {
  const event = templateEventTemplate({ name: 'static-site', content: FIXTURE_CONTENT, createdAt: 1_700_000_000 });

  assert.equal(event.kind, K_TEMPLATE);
  // No `x` tag: a Template is found by name, and the digest it carries is
  // the image's, not its own (spec §8.3).
  assert.deepEqual(event.tags, [['d', 'static-site'], ['L', TOON_LABEL]]);
  assert.equal(event.content, FIXTURE_JSON);
});

test('a Template written in any key order publishes in the fixture\'s', () => {
  // The content is rebuilt field by field rather than re-serialized as it
  // arrived, so a hand-written JSON file and the fixture make the same event.
  const shuffled = {
    env_tenant: ['SITE_TITLE'],
    min_resources: { storage_gb: 4, memory_mb: 256, cpu_millicores: 500 },
    ports: [{ protocol: 'tcp', container_port: 8080 }],
    image: { registry_entry: { relay: 'ws://relay.fixture.example:7100', address: `30434:${PUBLISHER}:web:1.0` }, digest: FIXTURE_CONTENT.image.digest },
    env_fixed: { MODE: 'production' },
    data_path: '/data',
    version: 1,
  };

  assert.equal(templateEventTemplate({ name: 'static-site', content: shuffled, createdAt: 1 }).content, FIXTURE_JSON);
});

test('publishing signs it, writes it to the relay once, and reports its address', async () => {
  const secretKey = generateSecretKey();
  const io = fakeIo();

  const report = await publishTemplate({ name: 'static-site', content: FIXTURE_CONTENT, secretKey, io, now: () => 1_700_000_000 });

  const [event] = io.published;
  assert.equal(io.published.length, 1);
  assert.equal(event.pubkey, getPublicKey(secretKey));
  assert.ok(verifyEvent(event), 'signed by the template author');
  assert.equal(event.content, FIXTURE_JSON);
  assert.equal(report.address, `${K_TEMPLATE}:${getPublicKey(secretKey)}:static-site`);
  assert.equal(report.name, 'static-site');
  assert.equal(report.template.event_id, event.id);
});

test('a Template the tenant-side expander would refuse is never published', async () => {
  // The publisher runs the reader's own check before it signs: publishing a
  // Template nobody can expand costs a relay write and helps no one.
  const io = fakeIo();
  const secretKey = generateSecretKey();

  await assert.rejects(
    publishTemplate({ name: 'static-site', content: { ...FIXTURE_CONTENT, privileged: true }, secretKey, io }),
    /ADR 0004/,
  );
  await assert.rejects(publishTemplate({ name: '', content: FIXTURE_CONTENT, secretKey, io }), /name/);
  assert.deepEqual(io.published, [], 'nothing was published');
});

test('what the publisher signs is what a tenant reads back and expands', async () => {
  const secretKey = generateSecretKey();
  const io = fakeIo();

  await publishTemplate({ name: 'static-site', content: FIXTURE_CONTENT, secretKey, io });

  const template = templateFromEvent(io.published[0]);
  const spawn = expandTemplate(template, {
    values: { SITE_TITLE: 'Hello' },
    workloadId: 'a'.repeat(64),
    sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@sandbox',
  });
  assert.equal(spawn.template, `${K_TEMPLATE}:${getPublicKey(secretKey)}:static-site`);
  assert.deepEqual(spawn.image, FIXTURE_CONTENT.image);
  assert.deepEqual(spawn.env, { MODE: 'production', SITE_TITLE: 'Hello' });
});
