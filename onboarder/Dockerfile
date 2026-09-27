# The Onboarder: a stock x402 facilitator (see index.mjs). The sandbox builds
# it from here (sandbox/docker-compose.yml); .github/workflows/onboarder-image.yml
# publishes it as ghcr.io/toon-protocol/onboarder for the devnet, which pins it
# by digest (deploy/docker-compose.yml). Dependencies are built into the image,
# pinned by package-lock.json, so a start needs no registry.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.mjs config.mjs ./
EXPOSE 4022
CMD ["node", "index.mjs"]
