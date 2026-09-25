# The sandbox's x402 facilitator (see index.mjs and the compose service).
# Dependencies are built into the image, pinned by package-lock.json, for the
# same cold-start reason as the seed image next door.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.mjs ./
EXPOSE 4022
CMD ["node", "index.mjs"]
