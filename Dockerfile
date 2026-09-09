FROM node:22-slim AS base

# Prisma's query engine needs libssl on Debian slim images — without it,
# Prisma silently guesses the wrong engine target (confirmed via a Railway
# deploy: "failed to detect the libssl/openssl version... defaulting to
# openssl-1.1.x") instead of a hard failure, which is worse.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn db:generate && yarn build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "yarn db:push && node dist/index.js"]
