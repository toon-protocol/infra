# Image for the one-shot `seed-solana` init job (see docker-compose.yml).
# Building the deps into the image (rather than npm-ci-ing in an entrypoint)
# favors cold-start reliability: `docker compose up` builds it once, cached
# thereafter, and the job itself needs no network beyond the validator.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/ scripts/
# keys/ is bind-mounted read-only at runtime (see compose)
CMD ["node", "scripts/seed-solana.mjs"]
