#!/usr/bin/env bash
#
# Apply what was merged. Run by systemd on a timer; see README.md.
#
# The host half of GitOps (connector ADR 0068), in the same shape as
# edge/deploy/auto-apply.sh, which says why each rule is there:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset;
#   * the last commit applied SUCCESSFULLY is recorded in ./.applied, so a
#     failed apply is retried, and fails loudly, every five minutes;
#   * the placeholder image digest is refused by name;
#   * the onboarder must come back healthy, or this exits non-zero.
#
# ── How it differs from the edge's copy ──────────────────────────────────────
# 1. Its own units and lock: toon-auto-apply-onboarder.{service,timer} and
#    /var/lock/toon-auto-apply-onboarder.lock.
# 2. It shares /root/infra with the edge, so both also take
#    /var/lock/toon-infra-checkout.lock around the fetch and fast-forward, and
#    only there: two timers firing together would otherwise race on git's own
#    index.lock. Whichever runs second finds HEAD already moved and applies it,
#    because .applied, not HEAD, is what says this bundle is applied.
# 3. No reload step. Everything the service reads is in its compose definition
#    or its image, so `up -d` recreating it is the whole apply.
# 4. It refuses to start without ./onboarder.key: Docker would otherwise
#    bind-mount a new, empty DIRECTORY in its place.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/../.." && pwd)
cd "$REPO_DIR"

TRACK_BRANCH=main
if [ -f "$DEPLOY_DIR/.env" ]; then
  # Only this one variable, and only from a well-formed line: sourcing .env
  # would pull the RPC URL, and any API key in it, into this script for nothing.
  value=$(sed -n 's/^[[:space:]]*TRACK_BRANCH[[:space:]]*=[[:space:]]*//p' "$DEPLOY_DIR/.env" | tail -n 1 | tr -d '"'"'"' \t\r')
  [ -n "$value" ] && TRACK_BRANCH=$value
fi

# One apply at a time, and never one racing a human.
exec 9>/var/lock/toon-auto-apply-onboarder.lock
flock -n 9 || { echo "another onboarder apply is already running; leaving it alone"; exit 0; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING: the working tree at $REPO_DIR is dirty."
  echo "Someone is editing on the host. Commit, stash or discard it, then this resumes on its own."
  exit 1
fi

exec 8>/var/lock/toon-infra-checkout.lock
flock -w 120 8 || { echo "FAILED: the infra checkout stayed locked for 120s (the edge's apply?)"; exit 1; }
if ! git fetch -q origin "$TRACK_BRANCH"; then
  echo "FAILED: origin has no branch '$TRACK_BRANCH'. Set TRACK_BRANCH in onboarder/deploy/.env."
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
flock -u 8

cd "$DEPLOY_DIR"
# As the edge's: .env's COMPOSE_FILE, when it sets one, is read by `docker
# compose` itself, and an explicit -f here would silently drop what it names.
if [ -f .env ] && grep -q '^[[:space:]]*COMPOSE_FILE=' .env; then
  COMPOSE=()
else
  COMPOSE=(-f docker-compose.yml)
fi

if grep -q 'onboarder@sha256:0\{64\}' docker-compose.yml; then
  echo "REFUSING: docker-compose.yml still pins the PLACEHOLDER onboarder digest."
  echo "Publish the image and commit its digest; see onboarder/deploy/README.md."
  exit 1
fi

if [ ! -f onboarder.key ]; then
  echo "REFUSING: $DEPLOY_DIR/onboarder.key does not exist."
  echo "Write the gas payer's key there first; see onboarder/deploy/README.md § \"The key\"."
  exit 1
fi

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

# Docker resets Health.Status to `starting` on a recreate, so this cannot read
# a stale `healthy` from the container it replaced.
ONBOARDER=$(docker compose "${COMPOSE[@]}" ps -q onboarder)
if [ -z "$ONBOARDER" ]; then
  echo "FAILED: no onboarder container after \`up -d\` at ${REMOTE:0:7}."
  exit 1
fi
for _ in $(seq 1 40); do
  STATUS=$(docker inspect "$ONBOARDER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "$STATUS" = healthy ] && break
  sleep 3
done
if [ "${STATUS:-unknown}" != healthy ]; then
  # /health's body names the reason: wrong chain, no contract, or no ETH.
  echo "FAILED: the onboarder is '${STATUS:-unknown}' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" exec -T onboarder \
    node -e 'fetch("http://127.0.0.1:4022/health").then((r) => r.text()).then(console.log)' || true
  docker compose "${COMPOSE[@]}" logs --tail 40 onboarder || true
  exit 1
fi

echo "$REMOTE" > "$APPLIED_MARKER"
echo "applied ${REMOTE:0:7}; onboarder healthy."
