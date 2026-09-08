FROM node:22-slim AS base

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn db:generate && yarn build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "yarn db:push && node dist/index.js"]
