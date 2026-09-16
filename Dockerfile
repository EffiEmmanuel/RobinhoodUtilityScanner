FROM node:22-slim AS base

# Prisma's query engine needs libssl on Debian slim images — without it,
# Prisma silently guesses the wrong engine target (confirmed via a Railway
# deploy: "failed to detect the libssl/openssl version... defaulting to
# openssl-1.1.x") instead of a hard failure, which is worse.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
# chartVisionGate.ts screenshots DexScreener's chart widget with Playwright —
# node:22-slim has neither the Chromium binary nor the OS libs it needs
# (fonts, libnss3, libatk, ...); --with-deps installs both via apt. Without
# this, chromium.launch() throws at runtime and the gate silently fails open
# on every trailing exit (caught in screenshotChart, logged as a warning) —
# not unsafe, but a silently inert feature rather than a working one.
RUN npx playwright install --with-deps chromium

COPY . .
RUN yarn db:generate && yarn build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "yarn db:push && node dist/index.js"]
