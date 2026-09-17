# anon v0.4.10.2 — the Anyone Protocol daemon the `hs` profile runs.
#
# VENDORED FROM the anytoon sibling checkout's anon-image/Dockerfile, which is
# the reference implementation for this pattern. Copied rather than referenced
# so `make up-hs` needs no extra checkout beyond the two `make up` already
# requires, and so this sandbox's daemon cannot drift when that repo moves.
#
# WHY THIS FILE EXISTS. ghcr.io/anyone-protocol/ator-protocol publishes no image
# for v0.4.10.2: its tag list stops at v0.4.9.7, from October 2024. So this
# overlays the official release binary onto that image, which keeps the image
# contract — the `anond` user, /var/lib/anon and its ownership, the entrypoint —
# identical. The binary is statically linked, so nothing else has to come with
# it.
#
# THE VERSION IS THE WHOLE POINT. Anyone Protocol renamed the hidden-service TLD
# between these two releases, and the rename is total in both directions:
#
#            | anon v0.4.9.7        | anon v0.4.10.2
#   TLD      | .onion               | .anyone
#   other    | ".anyone" absent     | ".onion" — ZERO occurrences
#
# v0.4.10.2 writes `<56-base32>.anyone` into HiddenServiceDir/hostname, routes
# it, and REFUSES the same address spelled `.onion`. @toon-protocol/client
# accepts `.anyone` and nothing else — its own hostname regex is
# /^[a-z2-7]+\.anyone$/ and it rejects `.onion` BY NAME, because that is Tor and
# not `anon`. So a daemon at the older pin publishes an address every client in
# this sandbox refuses. Do not "simplify" this back to the ghcr tag.
FROM ghcr.io/anyone-protocol/ator-protocol:v0.4.9.7

ARG ANON_VERSION=v0.4.10.2
# sha256 of anon-live-linux-amd64.zip — the same figure toon-client records in
# packages/client/src/cli/anon-daemon.ts and anytoon's anon-image/Dockerfile
# carries. Checked BEFORE the binary is ever executed: an unverified download is
# not an upgrade.
ARG ANON_SHA256=9c6498b8d27de54d78842a1b854979a605f9c140ccc34f2b4c267bf094eaeb17

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl unzip ca-certificates; \
    # socat is KEPT (curl and unzip below are not). The `hs-ingress` service in
    # docker-compose.yml runs this same image as a plain TCP forwarder inside
    # the network namespace this daemon shares — see the comment on `anon`
    # there for why the daemon's HiddenServicePort has to name 127.0.0.1.
    # Installing it here means the `hs` profile builds ONE image and pulls no
    # second one for two `socat` invocations.
    apt-get install -y --no-install-recommends socat; \
    # iptables is KEPT for the same reason, and only one service needs it:
    # the HIDDEN PROVIDER's daemon (`anon-hs`, conf/anonrc-hs) is the
    # transparent-egress gateway of the `hs-egress` network, and a
    # TransPort is reachable only through the nat/PREROUTING REDIRECT rules
    # its own container installs at boot. Debian's iptables is the nft
    # backend; the rules live in that container's own network namespace.
    apt-get install -y --no-install-recommends iptables; \
    curl -fsSL -o /tmp/anon.zip \
      "https://github.com/anyone-protocol/ator-protocol/releases/download/${ANON_VERSION}/anon-live-linux-amd64.zip"; \
    echo "${ANON_SHA256}  /tmp/anon.zip" | sha256sum -c -; \
    unzip -o -j /tmp/anon.zip -d /tmp/anon; \
    install -m 0755 /tmp/anon/anon /usr/local/bin/anon; \
    install -m 0644 /tmp/anon/geoip  /usr/local/share/anon/geoip; \
    install -m 0644 /tmp/anon/geoip6 /usr/local/share/anon/geoip6; \
    rm -rf /tmp/anon /tmp/anon.zip; \
    apt-get purge -y curl unzip; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    # Fail the BUILD, not the first bring-up, if the wrong release was fetched.
    anon --version | grep -q "0.4.10.2"
