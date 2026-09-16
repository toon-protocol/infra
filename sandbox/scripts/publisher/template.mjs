// Publish a Template (TOON_Network #25; spec §8.3, ADR 0004).
//
// A Template is a published description of a spawn: an image by content
// address, its ports, where it keeps state, the settings its author fixed and
// the settings a tenant may supply. It GRANTS NOTHING — there is no
// capability field and there never will be (ADR 0004) — and it is expanded by
// the TENANT (../lib/template.mjs), never by a provider.
//
// So this module is small on purpose: what a Template may say is the reader's
// rule, not the publisher's, and `checkTemplateContent` is imported from the
// expander rather than restated here. A Template no tenant could expand is
// refused before it is signed.
//
// One seam, the same as blob.mjs's:  io.relay.publish(event) -> void
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { TOON_LABEL } from '../lib/provider-smoke.mjs';
import { K_TEMPLATE, checkTemplateContent, templateAddress } from '../lib/template.mjs';

export { K_TEMPLATE, TOON_LABEL, templateAddress };

/**
 * The unsigned Template event for `content` (spec §8.3). No `x` tag: a
 * Template is found by name, and the digest it carries is the image's, not
 * its own.
 *
 * The content is rebuilt field by field, in the order §8.3 writes them, so
 * that a hand-written JSON file and the wire fixture make the same event
 * whatever order their keys happen to be in.
 */
export function templateEvent({ name, content, createdAt }) {
  checkName(name);
  checkTemplateContent(content);
  const image = { digest: content.image.digest };
  if (content.image.registry_entry) {
    image.registry_entry = { address: content.image.registry_entry.address, relay: content.image.registry_entry.relay };
  }
  const body = {
    version: content.version,
    image,
    ports: content.ports.map((p) => ({ container_port: p.container_port, protocol: p.protocol })),
    ...(content.data_path === undefined ? {} : { data_path: content.data_path }),
    env_fixed: content.env_fixed,
    env_tenant: content.env_tenant,
    ...(content.min_resources === undefined ? {} : { min_resources: resources(content.min_resources) }),
  };
  return {
    kind: K_TEMPLATE,
    created_at: createdAt,
    tags: [['d', name], ['L', TOON_LABEL]],
    content: JSON.stringify(body),
  };
}

/** A Listing's `resources` in spec §4.2's order (`gpu` only when there is one). */
const resources = (r) => ({
  cpu_millicores: r.cpu_millicores,
  memory_mb: r.memory_mb,
  storage_gb: r.storage_gb,
  ...(r.gpu === undefined ? {} : { gpu: r.gpu }),
});

function checkName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('a Template\'s name is its `d` tag, and may not be empty');
  if (name !== name.trim() || /[\s]/.test(name)) throw new Error(`a Template's name may not carry whitespace: ${JSON.stringify(name)}`);
}

/**
 * Sign `content` as the Template named `name` and publish it to the relay.
 * Addressable, so re-publishing the same name REPLACES it (spec §8.3) rather
 * than adding a second Template. Resolves to
 *   { address, name, template: { event_id, event } }
 * Nothing is published if the content is not one a tenant could expand.
 */
export async function publishTemplate({ name, content, secretKey, io, now = () => Math.floor(Date.now() / 1000) }) {
  const unsigned = templateEvent({ name, content, createdAt: now() });
  const event = finalizeEvent(unsigned, secretKey);
  await io.relay.publish(event);
  return {
    address: templateAddress(getPublicKey(secretKey), name),
    name,
    template: { event_id: event.id, event },
  };
}
