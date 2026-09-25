#!/usr/bin/env bash
#
# Apply what was merged. Run by systemd on a timer; see README.md.
#
# The host half of GitOps (connector ADR 0068), in the same shape as every
# node's deploy/auto-apply.sh: the repository is the deploy surface, and this
# script's whole job is to notice that the tracked branch moved and apply it.
# PULL-based on purpose: nothing outside this host can make it deploy.
#
# It refuses rather than guesses:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset;
#   * "nothing new upstream" is not "applied": the last commit applied
#     SUCCESSFULLY is recorded in ./.applied, so a run that failed after the
#     fast-forward (a bad pull, an unhealthy Caddy, a rejected config, the
#     placeholder) is retried and fails loudly every five minutes, instead of
#     the next run seeing HEAD == origin and exiting green;
#   * the placeholder image digest is refused by name, not pulled and failed;
#   * Caddy must come back healthy, and must accept the new config, or this
#     exits non-zero so `systemctl status` and the journal show it.
#
# ── How it differs from a node's copy ────────────────────────────────────────
# 1. The bundle is edge/deploy in toon-protocol/infra, not deploy/ in an app
#    repository, so the checkout root is two levels up.
# 2. Per-node unit names and lock, as every bundle on a shared host has them
#    (contract v2): toon-auto-apply-edge.{service,timer} and
#    /var/lock/toon-auto-apply-edge.lock. One shared lock would make the edge
#    skip every run that overlaps a node's, and a node skip every run that
#    overlaps the edge's.
# 3. A config change is applied by `caddy reload`, never by a restart. A
#    reload is graceful (open WebSockets are kept; see sites.caddy's
#    stream_close_delay), it is a no-op when nothing changed, and an invalid
#    config is REJECTED while the old one keeps serving. Restarting the one TLS
#    front on the host would drop every node's traffic at once.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/../.." && pwd)
cd "$REPO_DIR"

TRACK_BRANCH=main
if [ -f "$DEPLOY_DIR/.env" ]; then
  # Only this one variable, and only from a well-formed line: sourcing .env
  # would pull the Porkbun keys into this script's environment for no reason.
  value=$(sed -n 's/^[[:space:]]*TRACK_BRANCH[[:space:]]*=[[:space:]]*//p' "$DEPLOY_DIR/.env" | tail -n 1 | tr -d '"'"'"' \t\r')
  [ -n "$value" ] && TRACK_BRANCH=$value
fi

# One apply at a time, and never one racing a human.
exec 9>/var/lock/toon-auto-apply-edge.lock
flock -n 9 || { echo "another edge apply is already running; leaving it alone"; exit 0; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING: the working tree at $REPO_DIR is dirty."
  echo "Someone is editing on the host. Commit, stash or discard it, then this resumes on its own."
  exit 1
fi

if ! git fetch -q origin "$TRACK_BRANCH"; then
  echo "FAILED: origin has no branch '$TRACK_BRANCH'. Set TRACK_BRANCH in edge/deploy/.env."
  exit 1
fi
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse FETCH_HEAD)
APPLIED_MARKER=$DEPLOY_DIR/.applied
APPLIED=$(cat "$APPLIED_MARKER" 2>/dev/null || true)
if [ "$LOCAL" = "$REMOTE" ] && [ "$APPLIED" = "$REMOTE" ]; then
  exit 0   # nothing merged since the last successful apply; the quiet, common case
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "applying ${LOCAL:0:7} -> ${REMOTE:0:7} (origin/$TRACK_BRANCH)"
  git merge --ff-only FETCH_HEAD
else
  LAST=${APPLIED:-never}
  echo "re-applying ${REMOTE:0:7}: the last successful apply was ${LAST:0:7}"
fi

cd "$DEPLOY_DIR"
# Which compose files this host runs is .env's COMPOSE_FILE, when it sets one,
# read by `docker compose` itself: an explicit `-f` here would override it and
# silently drop whatever overlay it names. So this only asks whether .env HAS
# such a line, never what it says (and never sources .env, which holds the
# Porkbun keys). No COMPOSE_FILE: the base file alone.
if [ -f .env ] && grep -q '^[[:space:]]*COMPOSE_FILE=' .env; then
  COMPOSE=()
else
  COMPOSE=(-f docker-compose.yml)
fi

# The bundle ships a PLACEHOLDER digest until edge-image.yml has published an
# image (README § "Bumping the image"). Say so, rather than letting a pull fail
# with "manifest unknown".
if grep -q 'edge-caddy@sha256:0\{64\}' docker-compose.yml; then
  echo "REFUSING: docker-compose.yml still pins the PLACEHOLDER edge-caddy digest."
  echo "Publish the image and commit its digest; see edge/deploy/README.md."
  exit 1
fi

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

# Docker resets Health.Status to `starting` on a recreate, so this cannot read
# a stale `healthy` from the container it replaced.
CADDY=$(docker compose "${COMPOSE[@]}" ps -q caddy)
if [ -z "$CADDY" ]; then
  echo "FAILED: no caddy container after \`up -d\` at ${REMOTE:0:7}."
  exit 1
fi
for _ in $(seq 1 40); do
  STATUS=$(docker inspect "$CADDY" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "$STATUS" = healthy ] && break
  sleep 3
done
if [ "${STATUS:-unknown}" != healthy ]; then
  echo "FAILED: caddy is '${STATUS:-unknown}' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" logs --tail 40 caddy || true
  exit 1
fi

# `up -d` recreates the container on a changed image or compose definition,
# never on changed bytes behind the ./caddy bind mount. So load the merged
# config explicitly. Unchanged config: a no-op. Invalid config: rejected, the
# old one keeps serving, and this run fails loudly.
if ! docker compose "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
  echo "FAILED: caddy rejected the config at ${REMOTE:0:7}; it is still serving the previous one."
  exit 1
fi

echo "$REMOTE" > "$APPLIED_MARKER"
echo "applied ${REMOTE:0:7}; caddy healthy, config loaded."
