# UtilityScout

A 24/7 agent that watches DexScreener for new Robinhood Chain tokens, filters out obvious
memecoins, deep-researches what's left (market data, website, on-chain contract risk), scores it
deterministically, and emails you when something clears the bar. See [utility-scout-prd.md](utility-scout-prd.md)
for the full product spec this implements a lean version of.

## What's different from the PRD's "recommended" stack, and why

The PRD's recommended stack (Postgres, Redis+BullMQ, Playwright, a dashboard, a monorepo) is the
right shape for a mature product. For a first working version, this build makes deliberately
smaller choices that still satisfy every functional requirement:

| PRD recommendation | This build | Why |
|---|---|---|
| Postgres | Postgres (via Prisma, driver-adapter mode) | As specced — real Postgres, not a local file. `docker-compose.yml` includes a `postgres` service so local dev doesn't need anything installed beyond Docker; swap `DATABASE_URL` to point at any managed Postgres for production. |
| Redis + BullMQ, 6 named queues | `Token.status` as the queue, polled by a plain worker loop | At one chain's worth of token volume, a DB-backed state machine (`DETECTED → CLASSIFYING → RESEARCH_QUEUED → RESEARCHING → ALERTED/WATCHLISTED/REJECTED`) gives the same crash-resumable, retry-safe behavior without another service to run. |
| Playwright + headless Chromium | `fetch` + Cheerio | Most project sites are static/SSR enough for this to work (verified live against real sites). Swapping in Playwright later only touches `src/research/website.ts`. |
| Full dashboard (Next.js/React) | Minimal read-only Fastify API (`/health`, `/tokens`, `/alerts`, `/watchlist`, `/rejected`) | You can inspect everything via the API or `yarn db:studio`; a UI is easy to add later against the same endpoints. |
| Monorepo (Turborepo/pnpm workspaces) | Single package | Nothing here needs independent deployability yet. |

Everything else — the progressive research funnel, deterministic weighted scoring, hard-reject
rules, confidence tracking, structured AI output validated with Zod — is implemented as specced.

## Prerequisites

- **Node 22+** (this repo pins it via `.nvmrc` — run `nvm use` if you have nvm). Prisma 7 requires
  Node ≥22.
- **Yarn** (classic, v1.x is fine)
- **PostgreSQL** — either a local instance (see below) or `docker compose up postgres -d`
- An **Anthropic API key** (for classification + research synthesis)
- A **Resend API key** + a verified sending domain (for email alerts) — https://resend.com

## Setup

```bash
nvm use            # switches to Node 22 if you have nvm
yarn install
cp .env.example .env
# edit .env: at minimum set ANTHROPIC_API_KEY, RESEND_API_KEY, ALERT_EMAIL_FROM, ALERT_EMAIL_TO

# get Postgres running — pick one:
docker compose up postgres -d
#   -- or, against a Postgres you already run locally --
# createuser utilityscout --pwprompt   (set password "utilityscout", or update .env to match)
# createdb utilityscout --owner=utilityscout

yarn db:generate
yarn db:push        # creates the tables in the `utilityscout` database
yarn dev
```

The app starts two things in one process:
- The pipeline orchestrator (discovery poll + worker loop)
- A small HTTP API on `http://localhost:3000`

Without `ANTHROPIC_API_KEY`/`RESEND_API_KEY` set, discovery and cheap filtering still run fully
(and against the live DexScreener API), but classification/research/alerting will fail loudly in
the logs — useful for a first smoke test without spending on AI calls.

Check `curl localhost:3000/health` and `curl localhost:3000/tokens` while it's running.

## How the pipeline works

```
DexScreener poll (every DISCOVERY_INTERVAL_SECONDS)
  → filter to TARGET_CHAIN_ID ("robinhood")
  → dedupe on (chain, address)
  → cheap filter (missing name/icon/malformed address) — free, no AI
  → [DETECTED] visual classification (Claude, image + metadata) — cheap model
  → gate: utilityProbability / memeProbability thresholds
  → [RESEARCH_QUEUED] deep research, concurrently:
      - DexScreener market data (liquidity, volume, buys/sells)
      - website fetch + text/link extraction
      - on-chain checks via viem (mint/pause/blacklist/fee-control bytecode
        selectors, owner renouncement, verified-source lookup)
  → research synthesis (Claude, one structured call over everything gathered)
  → deterministic weighted score (src/scoring/index.ts — never AI-decided)
  → hard-reject rules can override a high score
  → [ALERTED / WATCHLISTED / REJECTED] email if it clears ALERT_THRESHOLD
```

Every stage persists its evidence (`Classification`, `ResearchRun.rawResearch`, `MarketSnapshot`)
so a bad call is debuggable and the data is there for backtesting later.

## Configuration

See [.env.example](.env.example) for the full list. The important ones to tune once you've watched
it run for a while:

- `MIN_UTILITY_PROBABILITY` / `MAX_MEME_PROBABILITY` — the classification gate
- `WATCHLIST_THRESHOLD` / `ALERT_THRESHOLD` / `MIN_CONFIDENCE_TO_ALERT` — final score gates
- `MIN_LIQUIDITY_USD` / `MIN_LIQUIDITY_TO_MCAP_RATIO` — liquidity scoring and the emergency
  hard-reject floor (liquidity below 20% of `MIN_LIQUIDITY_USD` is an automatic reject)

Scoring weights themselves (`WEIGHTS` in `src/scoring/index.ts`) match the PRD's §20 table and are
a code change, not an env var — they're rarely tuned and a code review trail is more useful there
than a silent config change.

## Reference examples (calibrating the classifier)

Edit [examples/reference-examples.json](examples/reference-examples.json) — real winners, losers,
memes, and scams you've seen on Robinhood Chain, with notes on why. These are included as few-shot
context in the visual-classification prompt. The seed file has placeholder entries; replace them.

## Known limitations (v1)

- **Explorer verified-source lookups are usually `UNKNOWN`.** The Robinhood Chain Blockscout
  instance (`robinhoodchain.blockscout.com`) sits behind a Cloudflare bot challenge that a plain
  server-side request can't pass. This degrades gracefully (never fabricates a `PASS`) and only
  costs a small score/confidence penalty — the more important on-chain checks (mint/pause/
  blacklist/fee-control capability detection via bytecode, confirmed working against live RPC)
  don't depend on it. If you find a scriptable Robinhood Chain explorer API, swap the URL in
  `RH_EXPLORER_API_URL`.
- **No holder-distribution data source.** Would need an indexer; `holderScore` is a neutral 50
  with `LOW` confidence rather than a fabricated number (see PRD §25).
- **No watchlist auto-recheck or post-alert performance tracking yet.** The schema
  (`MarketSnapshot`) supports adding both — they're natural next additions once you've watched the
  system run for a while, deliberately left out of v1 to keep the first build small.
- **Website research can't execute JavaScript.** SPA-only sites will under-extract. Swap
  `src/research/website.ts` for Playwright if that turns out to matter in practice.

## Testing

```bash
yarn test        # scoring engine + cheap filter unit tests
yarn typecheck
```

## Deployment

The whole point is that this doesn't run on your laptop. On a VPS with Docker installed:

```bash
cp .env.example .env   # fill in real values
docker compose up -d --build
```

This runs both the app and a Postgres container, persisted in a named volume, and restarts
automatically (`unless-stopped`) across reboots/crashes. To use a managed Postgres instead (RDS,
DigitalOcean Managed Databases, Neon, Supabase, etc.) instead of the bundled container: remove the
`postgres` service from `docker-compose.yml`, drop the `depends_on`, and point `DATABASE_URL` (in
`.env`, without the compose-only override) at your managed instance.
