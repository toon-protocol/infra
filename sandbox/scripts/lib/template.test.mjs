// The tenant-side expander (TOON_Network #25), driven as a tenant drives it:
// a Template in, the spawn content of spec §6.2 out. Nothing here touches a
// relay — `expandTemplate` is the decision, and reading the Template from the
// relay is a separate helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplate, templateAddress, templateFromEvent, parseTemplateAddress, VOLUME_MOUNT_PATH } from './template.mjs';

const PUBLISHER = '6e3c6cc9d1e0d6a2d99c5cf6e1b5f70b0b6d5f1a8c3e2b4d6a8c0e2f4a6c8e01';
const DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@sandbox';
const WORKLOAD_ID = 'a'.repeat(64);

/** The Template of the M2-1 fixture (docs/spec/fixtures/wire/registry.template.json). */
const fixtureTemplate = (content = {}) => ({
  address: templateAddress(PUBLISHER, 'static-site'),
  publisher: PUBLISHER,
  name: 'static-site',
  content: {
    version: 1,
    image: {
      digest: DIGEST,
      registry_entry: {
        address: `30434:${PUBLISHER}:web:1.0`,
        relay: 'ws://relay.fixture.example:7100',
      },
    },
    ports: [{ container_port: 8080, protocol: 'tcp' }],
    data_path: VOLUME_MOUNT_PATH,
    env_fixed: { MODE: 'production' },
    env_tenant: ['SITE_TITLE'],
    min_resources: { cpu_millicores: 500, memory_mb: 256, storage_gb: 4 },
    ...content,
  },
});

const expand = (template, opts = {}) =>
  expandTemplate(template, { values: { SITE_TITLE: 'Hello' }, workloadId: WORKLOAD_ID, sshPublicKey: SSH_KEY, ...opts });

test('a Template plus one tenant value is a spawn of exactly the fields §6.2 allows', () => {
  const template = fixtureTemplate();

  const spawn = expand(template);

  assert.deepEqual(spawn, {
    workload_id: WORKLOAD_ID,
    image: { digest: DIGEST, registry_entry: { address: `30434:${PUBLISHER}:web:1.0`, relay: 'ws://relay.fixture.example:7100' } },
    env: { MODE: 'production', SITE_TITLE: 'Hello' },
    ports: [{ container_port: 8080, protocol: 'tcp' }],
    volume_gb: 4,
    ssh_public_key: SSH_KEY,
    template: `30436:${PUBLISHER}:static-site`,
  });
});

test('a tenant value the Template asked for and did not get is an error, naming every one missing', () => {
  const template = fixtureTemplate({ env_tenant: ['SITE_TITLE', 'ADMIN_EMAIL'] });

  assert.throws(
    () => expand(template),
    (e) => /no value for ADMIN_EMAIL/.test(e.message) && !/no value for SITE_TITLE/.test(e.message),
    'the error names the value that is missing, not the one that was given',
  );
});

test('a value the Template never asked for is an error too', () => {
  // `env_tenant` is the whole of what a tenant may set: anything else is
  // either a typo for one of those names or a setting the author fixed.
  assert.throws(
    () => expand(fixtureTemplate(), { values: { SITE_TITLE: 'Hello', MODE: 'debug' } }),
    /MODE/,
  );
});

test('a Template carrying a capability-like field is refused, and the refusal says a Template grants nothing', () => {
  // ADR 0004: capabilities come from the LISTING. A Template that asks for a
  // privilege is refused whole, not quietly stripped — a tenant who ran the
  // stripped version would be running something its author did not describe.
  for (const [field, value] of [
    ['privileged', true],
    ['capabilities', ['SYS_ADMIN']],
    ['runtime_flags', ['--privileged']],
    ['mounts', [{ host: '/', container: '/host' }]],
    ['devices', ['/dev/kvm']],
    ['docker', true],
  ]) {
    assert.throws(
      () => expand(fixtureTemplate({ [field]: value })),
      (e) => e.message.includes(field) && /grants no capability|ADR 0004/.test(e.message),
      `${field} must be refused`,
    );
  }
});

test('a field spec §8.3 does not define is refused, wherever it sits', () => {
  assert.throws(() => expand(fixtureTemplate({ entrypoint: ['/bin/sh'] })), /entrypoint/);
  assert.throws(
    () => expand(fixtureTemplate({ image: { digest: DIGEST, reference: 'docker.io/library/alpine' } })),
    /reference/,
    'a Template names an image by content address, never by an upstream reference (§8.3)',
  );
});

test('a Template with no data_path asks for no volume', () => {
  const spawn = expand(fixtureTemplate({ data_path: undefined }));
  assert.equal('volume_gb' in spawn, false);
});

test('a data_path the provider does not mount at is refused before anything is paid', () => {
  // A spawn has `volume_gb` and no mount path (§6.2): the provider always
  // mounts at /data, so a Template naming another path describes a workload
  // whose state would land somewhere it does not expect.
  assert.throws(
    () => expand(fixtureTemplate({ data_path: '/var/lib/postgresql/data' })),
    (e) => e.message.includes('/var/lib/postgresql/data') && e.message.includes(VOLUME_MOUNT_PATH),
  );
});

test('the tenant sizes the volume; the Template only says it wants one', () => {
  assert.equal(expand(fixtureTemplate(), { volumeGb: 2 }).volume_gb, 2);
  assert.equal(expand(fixtureTemplate({ min_resources: undefined })).volume_gb, 1, 'a floor of one GiB when nothing says more');
});

test('a spawn the provider would refuse on sight is refused here instead', () => {
  // §6.2: the workload id is 32 random bytes as hex and the SSH key is one
  // OpenSSH line. Both are the tenant's to get right, and a spawn that fails
  // on them is a paid refusal (ADR 0003).
  assert.throws(() => expand(fixtureTemplate(), { workloadId: 'not-hex' }), /workload_id/);
  assert.throws(() => expand(fixtureTemplate(), { sshPublicKey: '' }), /ssh_public_key/);
});

test('a Template read off the relay is its event: kind, `d` and content, with the address it was found at', () => {
  const event = {
    kind: 30436,
    pubkey: PUBLISHER,
    created_at: 1700000000,
    tags: [['d', 'static-site'], ['L', 'toon.network']],
    content: JSON.stringify(fixtureTemplate().content),
  };

  const template = templateFromEvent(event);

  assert.equal(template.address, `30436:${PUBLISHER}:static-site`);
  assert.equal(template.name, 'static-site');
  assert.equal(template.publisher, PUBLISHER);
  assert.deepEqual(template.content, fixtureTemplate().content);
  // And it expands, which is the whole point of reading one back.
  assert.equal(expand(template).template, template.address);
});

test('an event that is not a Template is not read as one', () => {
  const ok = { kind: 30436, pubkey: PUBLISHER, tags: [['d', 'static-site']], content: JSON.stringify(fixtureTemplate().content) };
  assert.throws(() => templateFromEvent({ ...ok, kind: 30434 }), /30436/);
  assert.throws(() => templateFromEvent({ ...ok, tags: [] }), /`d`/);
  assert.throws(() => templateFromEvent({ ...ok, content: 'not json' }), /content/);
});

test('an address names the Template to read: kind, publisher, name', () => {
  assert.deepEqual(parseTemplateAddress(`30436:${PUBLISHER}:static-site`), { pubkey: PUBLISHER, name: 'static-site' });
  assert.throws(() => parseTemplateAddress(`30434:${PUBLISHER}:web:1.0`), /30436/, 'an Image Registry entry is not a Template');
  assert.throws(() => parseTemplateAddress(`30436:${PUBLISHER}:`), /name/);
  assert.throws(() => parseTemplateAddress('30436:nothex:static-site'), /pubkey/);
});

test('a tenant value that is not a string is refused: the provider would only bill for saying so', () => {
  // §6.2's `env` is an object of environment VARIABLES, and the provider
  // parses it as strings — a number here is `invalid_request` on a paid
  // route (ADR 0003).
  assert.throws(() => expand(fixtureTemplate(), { values: { SITE_TITLE: 5 } }), /SITE_TITLE/);
  assert.throws(() => expand(fixtureTemplate(), { values: { SITE_TITLE: null } }), /SITE_TITLE/);
});

test('a Template that lists the same port twice is refused', () => {
  // The provider refuses `80/tcp is listed twice` as invalid_request, and
  // that refusal is billed: a Template nobody could spawn is caught here.
  assert.throws(
    () => expand(fixtureTemplate({ ports: [{ container_port: 8080, protocol: 'tcp' }, { container_port: 8080, protocol: 'tcp' }] })),
    /8080\/tcp/,
  );
  // The same port on the other protocol is two ports, not one twice.
  assert.equal(expand(fixtureTemplate({ ports: [{ container_port: 8080, protocol: 'tcp' }, { container_port: 8080, protocol: 'udp' }] })).ports.length, 2);
});
