// Expanding a Template into a spawn, tenant-side (TOON_Network #25; spec
// §8.3, §6.2, ADR 0004).
//
// The provider NEVER reads a Template. A tenant reads one, supplies the
// settings its author left open, and signs the resulting spawn itself — so a
// template author is never trusted by anyone but the tenant who chose them,
// and a Template can grant no privilege the tenant could not have asked for
// by hand.
//
// That is the whole of what this module enforces:
//
//   - the expansion emits ONLY the fields spec §6.2 allows a spawn, so a
//     Template can never smuggle a runtime flag, a host mount, a device or a
//     capability into one (ADR 0004);
//   - a Template whose content carries such a field — or any field §8.3 does
//     not define — is refused HERE, before the tenant pays for anything;
//   - a tenant value the Template never asked for, or one it asked for and
//     the tenant did not give, is likewise an error before payment.
import { findTemplateOnRelay } from '../publisher/toon-io.mjs';

export const K_TEMPLATE = 30436;
export const K_IMAGE = 30434;

/// Where the provider mounts a workload's persistent volume. A spawn has
/// `volume_gb` and NO mount path (spec §6.2), so a Template's `data_path` is
/// expanded into "ask for a volume" — the path itself is the provider's, and
/// a Template that names a different one would be describing a workload this
/// provider cannot run.
export const VOLUME_MOUNT_PATH = '/data';

/** The address a Template is read back at: `30436:<pubkey>:<name>`. */
export const templateAddress = (pubkey, name) => `${K_TEMPLATE}:${pubkey}:${name}`;

/**
 * The publisher and name in `30436:<pubkey>:<name>`. Split at most three
 * ways, so a name holding a colon keeps it (the rule spec §6.2 states for an
 * Image Registry entry's four-field coordinate, applied here too).
 */
export function parseTemplateAddress(address) {
  const [kind, pubkey, ...rest] = String(address).split(':');
  const name = rest.join(':');
  if (Number(kind) !== K_TEMPLATE) throw new Error(`a Template's address is ${K_TEMPLATE}:<pubkey>:<name>, not kind ${JSON.stringify(kind)}`);
  if (!/^[0-9a-f]{64}$/.test(pubkey ?? '')) throw new Error(`a Template's address carries its author's 32-byte pubkey as hex, not ${JSON.stringify(pubkey)}`);
  if (name === '') throw new Error('a Template\'s address ends in its name, which may not be empty');
  return { pubkey, name };
}

/**
 * Read a Template out of the signed event a relay served: its kind, the name
 * in its `d` tag, and its content, checked against §8.3. The address it is
 * expanded under is computed from the event, never taken on trust — an event
 * is addressed by whoever signed it.
 */
export function templateFromEvent(event) {
  if (event?.kind !== K_TEMPLATE) throw new Error(`a Template is kind ${K_TEMPLATE}, not ${event?.kind}`);
  const name = event.tags?.find((t) => t[0] === 'd')?.[1];
  if (!name) throw new Error('a Template carries its name in a `d` tag');
  let content;
  try {
    content = JSON.parse(event.content);
  } catch (e) {
    throw new Error(`the content of Template ${name} is not JSON: ${e.message}`);
  }
  checkTemplateContent(content);
  return { address: templateAddress(event.pubkey, name), publisher: event.pubkey, name, content, event };
}

// ── what a Template may say (spec §8.3) ───────────────────────────────────
// A closed list, because a field nobody knows is a claim nobody checked. The
// expander refuses an undefined field rather than dropping it, and names the
// capability-like ones for what they are: the one thing a Template may never
// ask for (ADR 0004).
const TEMPLATE_FIELDS = ['version', 'image', 'ports', 'data_path', 'env_fixed', 'env_tenant', 'min_resources'];
const REQUIRED_FIELDS = ['version', 'image', 'ports', 'env_fixed', 'env_tenant'];
const IMAGE_FIELDS = ['digest', 'registry_entry'];
const PORT_FIELDS = ['container_port', 'protocol'];
const RESOURCE_FIELDS = ['cpu_millicores', 'memory_mb', 'storage_gb', 'gpu'];
const ENTRY_FIELDS = ['address', 'relay'];

/**
 * The fields that would be a PRIVILEGE if any of them were honoured. None is
 * part of §8.3, so the closed list above already refuses them; they are named
 * so the refusal can say WHY rather than "unknown field", which is the
 * difference between a template author fixing a typo and one learning that
 * TOON Network does not work the way they assumed.
 */
const CAPABILITY_LIKE = [
  'privileged', 'privilege', 'capabilities', 'cap_add', 'cap_drop', 'devices', 'device',
  'mounts', 'volumes', 'binds', 'host_mounts', 'runtime', 'runtime_flags', 'flags',
  'security_opt', 'sysctls', 'network_mode', 'pid', 'ipc', 'userns', 'docker', 'nesting',
];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function refuseUnknown(value, allowed, where) {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  const privileges = unknown.filter((k) => CAPABILITY_LIKE.includes(k.toLowerCase()));
  if (privileges.length > 0) {
    throw new Error(
      `${where}: ${privileges.join(', ')} — a Template grants no capability (ADR 0004, spec §8.3). ` +
        'Privileges come from the provider\'s Listing, so a Template that asks for one describes a spawn no provider would run.',
    );
  }
  throw new Error(`${where}: ${unknown.join(', ')} ${unknown.length > 1 ? 'are not fields' : 'is not a field'} spec §8.3 defines (${allowed.join(', ')})`);
}

/**
 * Refuse a Template whose content is not the shape spec §8.3 draws — before
 * the tenant pays for anything. The publisher runs the same check before it
 * signs, so a Template nobody could expand is never published either.
 */
export function checkTemplateContent(content) {
  if (!isObject(content)) throw new Error('a Template\'s content is a JSON object (spec §8.3)');
  refuseUnknown(content, TEMPLATE_FIELDS, 'this Template carries');
  const missing = REQUIRED_FIELDS.filter((f) => content[f] === undefined);
  if (missing.length > 0) throw new Error(`this Template has no ${missing.join(', ')} (spec §8.3 requires ${REQUIRED_FIELDS.join(', ')})`);

  if (!Number.isInteger(content.version) || content.version < 1) throw new Error(`a Template's version is a positive integer, not ${JSON.stringify(content.version)}`);

  if (!isObject(content.image)) throw new Error('a Template\'s image is an object of { digest, registry_entry? }');
  refuseUnknown(content.image, IMAGE_FIELDS, 'this Template\'s image carries');
  if (!/^sha256:[0-9a-f]{64}$/.test(content.image.digest ?? '')) {
    throw new Error(`a Template names its image by content address: image.digest must be sha256:<64 lowercase hex>, not ${JSON.stringify(content.image.digest)}`);
  }
  if (content.image.registry_entry !== undefined) {
    const entry = content.image.registry_entry;
    if (!isObject(entry)) throw new Error('image.registry_entry is { address, relay }');
    refuseUnknown(entry, ENTRY_FIELDS, 'this Template\'s image.registry_entry carries');
    if (!new RegExp(`^${K_IMAGE}:[0-9a-f]{64}:.+$`).test(entry.address ?? '')) {
      throw new Error(`image.registry_entry.address must be an Image Registry entry, ${K_IMAGE}:<pubkey>:<name>:<tag>, not ${JSON.stringify(entry.address)}`);
    }
    if (typeof entry.relay !== 'string' || entry.relay === '') throw new Error('image.registry_entry.relay must name a relay to look the entry up on');
  }

  if (!Array.isArray(content.ports)) throw new Error('a Template\'s ports is a list of { container_port, protocol }');
  const seen = new Set();
  for (const port of content.ports) {
    if (!isObject(port)) throw new Error('a Template\'s ports is a list of { container_port, protocol }');
    refuseUnknown(port, PORT_FIELDS, 'this Template\'s ports carry');
    if (!Number.isInteger(port.container_port) || port.container_port <= 0 || port.container_port > 65535) {
      throw new Error(`ports: ${JSON.stringify(port.container_port)} is not a container port`);
    }
    if (port.protocol !== 'tcp' && port.protocol !== 'udp') throw new Error(`ports: protocol is "tcp" or "udp", not ${JSON.stringify(port.protocol)}`);
    // The provider refuses a repeated port/protocol as invalid_request, and
    // that refusal is paid for (ADR 0003).
    const key = `${port.container_port}/${port.protocol}`;
    if (seen.has(key)) throw new Error(`ports: ${key} is listed twice`);
    seen.add(key);
  }

  if (content.data_path !== undefined && (typeof content.data_path !== 'string' || !content.data_path.startsWith('/'))) {
    throw new Error(`a Template's data_path is an absolute path, not ${JSON.stringify(content.data_path)}`);
  }

  if (!isObject(content.env_fixed) || Object.values(content.env_fixed).some((v) => typeof v !== 'string')) {
    throw new Error('a Template\'s env_fixed is an object of string settings the author fixed');
  }
  if (!Array.isArray(content.env_tenant) || content.env_tenant.some((n) => typeof n !== 'string' || n === '')) {
    throw new Error('a Template\'s env_tenant is a list of the setting NAMES a tenant may supply');
  }
  const fixedToo = content.env_tenant.filter((n) => Object.hasOwn(content.env_fixed, n));
  if (fixedToo.length > 0) {
    throw new Error(`${fixedToo.join(', ')}: env_fixed and env_tenant both claim ${fixedToo.length > 1 ? 'these settings' : 'this setting'} — a tenant cannot be asked for a value its author already fixed`);
  }

  if (content.min_resources !== undefined) {
    if (!isObject(content.min_resources)) throw new Error('a Template\'s min_resources is a Listing\'s resources (spec §4.2)');
    refuseUnknown(content.min_resources, RESOURCE_FIELDS, 'this Template\'s min_resources carries');
  }
  return content;
}

/**
 * Expand `template` into the content of a spawn Lease Request (spec §6.2).
 *
 *   expandTemplate(template, { values, workloadId, sshPublicKey, volumeGb })
 *
 * `template` is `{ address, content }` — what `readTemplate` returns.
 */
export function expandTemplate(template, { values = {}, workloadId, sshPublicKey, volumeGb, mountPath = VOLUME_MOUNT_PATH } = {}) {
  const content = checkTemplateContent(template?.content);
  checkValues(content, values);
  // The two the tenant brings, checked before it pays: a spawn that fails
  // §6.2's shape check is a refusal it was billed for (ADR 0003).
  if (!/^[0-9a-f]{64}$/.test(workloadId ?? '')) throw new Error(`workload_id is 32 random bytes as 64 lowercase hex characters, not ${JSON.stringify(workloadId)}`);
  if (typeof sshPublicKey !== 'string' || sshPublicKey.trim().split(/\s+/).length < 2) {
    throw new Error(`ssh_public_key is one OpenSSH public key line ("ssh-ed25519 AAAA… comment"), not ${JSON.stringify(sshPublicKey)}`);
  }
  if (content.data_path !== undefined && content.data_path !== mountPath) {
    throw new Error(
      `this Template keeps its state at ${content.data_path}, but a spawn has no mount path (spec §6.2): ` +
        `the provider mounts a workload's volume at ${mountPath}. Expand it against a provider that mounts there, or ask its author for a Template that does.`,
    );
  }
  const image = { digest: content.image.digest };
  if (content.image.registry_entry) image.registry_entry = { ...content.image.registry_entry };

  const spawn = {
    workload_id: workloadId,
    image,
    env: { ...content.env_fixed, ...values },
    ports: content.ports.map((p) => ({ ...p })),
    ssh_public_key: sshPublicKey,
    template: template.address,
  };
  if (content.data_path !== undefined) {
    spawn.volume_gb = volumeGb ?? content.min_resources?.storage_gb ?? 1;
  }
  return orderSpawn(spawn);
}

/**
 * The tenant's values are exactly `env_tenant`, no more and no less. Both
 * halves are checked HERE, before the caller signs or pays for anything: a
 * value the author asked for and did not get would reach the workload as an
 * unset variable, and one the author never asked for is either a typo for a
 * name that IS open or a setting the author deliberately fixed.
 */
function checkValues(content, values) {
  const asked = content.env_tenant;
  const given = Object.keys(values);
  const missing = asked.filter((name) => !Object.hasOwn(values, name));
  const notStrings = asked.filter((name) => Object.hasOwn(values, name) && typeof values[name] !== 'string');
  const unasked = given.filter((name) => !asked.includes(name));
  if (missing.length > 0 || unasked.length > 0 || notStrings.length > 0) {
    const faults = [
      missing.length > 0 ? `no value for ${missing.join(', ')}` : null,
      notStrings.length > 0 ? `${notStrings.join(', ')}: an environment variable's value is a string` : null,
      unasked.length > 0 ? `${unasked.join(', ')}: this Template does not open ${unasked.length > 1 ? 'those settings' : 'that setting'}` : null,
    ].filter(Boolean);
    throw new Error(
      `the Template's values are ${asked.length > 0 ? asked.join(', ') : '(none)'} — ${faults.join('; ')}`,
    );
  }
}

/** The spawn's fields in the order spec §6.2 tabulates them. */
function orderSpawn(spawn) {
  const order = ['workload_id', 'image', 'env', 'ports', 'volume_gb', 'ssh_public_key', 'entrypoint', 'args', 'template'];
  return Object.fromEntries(order.filter((k) => spawn[k] !== undefined).map((k) => [k, spawn[k]]));
}

// ── reading one off the relay ─────────────────────────────────────────────
// Free: a NIP-01 read, like every other directory lookup. Kept apart from
// `expandTemplate` so the decision above can be tested without a relay, and
// so a tenant that already has the event (from a smoke, from a cache) never
// pays a round trip to expand it.

/**
 * The Template at `30436:<pubkey>:<name>` as the relay holds it, or null.
 * Its content is checked against §8.3 on the way out, so a Template nobody
 * could expand is reported as an error here rather than as a refused spawn.
 */
export async function readTemplate(address) {
  const { pubkey, name } = parseTemplateAddress(address);
  const event = await findTemplateOnRelay(pubkey, name);
  return event ? templateFromEvent(event) : null;
}

/** Read the Template at `address` and expand it: the two steps a tenant takes. */
export async function expandTemplateFromRelay(address, options) {
  const template = await readTemplate(address);
  if (!template) throw new Error(`no kind ${K_TEMPLATE} Template at ${address} on the relay`);
  return { template, spawn: expandTemplate(template, options) };
}
