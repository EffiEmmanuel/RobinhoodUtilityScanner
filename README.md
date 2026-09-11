# UtilityScout

A 24/7 agent that watches DexScreener for new Robinhood Chain tokens, filters out obvious
memecoins, deep-researches what's left (market data, website, on-chain contract risk), scores it
deterministically, and emails you when something clears the bar. See [utility-scout-prd.md](utility-scout-prd.md)
for the full product spec this implements a lean version of.

It also includes a **trading extension** (paper/shadow simulation, real live execution, backtesting,
and a lean learning layer) — see
[utility-scout-autonomous-trading-learning-prd.md](utility-scout-autonomous-trading-learning-prd.md)
for that spec, and [the section below](#trading-extension-papershadowlive) for what's actually built.

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
- A **Gemini API key** (for classification + research synthesis) — https://aistudio.google.com/apikey
- A **Gmail account + App Password** (for email alerts, via SMTP) — free for up to 500 sends/24hr
  on a regular account (2000/24hr on Google Workspace); create one at
  https://myaccount.google.com/apppasswords (requires 2FA on the account). Any other SMTP provider
  works too — see `SMTP_HOST`/`SMTP_PORT` in `.env.example`.

## Setup

```bash
nvm use            # switches to Node 22 if you have nvm
yarn install
cp .env.example .env
# edit .env: at minimum set GEMINI_API_KEY, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM, ALERT_EMAIL_TO

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

Without `GEMINI_API_KEY`/`SMTP_USER`+`SMTP_PASS` set, discovery and cheap filtering still run fully
(and against the live DexScreener API), but classification/research/alerting will fail loudly in
the logs — useful for a first smoke test without spending on AI calls.

Check `curl localhost:3000/health` and `curl localhost:3000/tokens` while it's running.

## How the pipeline works

```
DexScreener poll (every DISCOVERY_INTERVAL_SECONDS)
  → filter to TARGET_CHAIN_ID ("robinhood")
  → dedupe on (chain, address)
  → cheap filter (missing name/icon/malformed address) — free, no AI
  → [DETECTED] visual classification (Gemini, image + metadata) — cheap/flash-lite model
  → gate: utilityProbability / memeProbability thresholds
  → [RESEARCH_QUEUED] deep research, concurrently:
      - DexScreener market data (liquidity, volume, buys/sells)
      - website fetch + text/link extraction
      - on-chain checks via viem (mint/pause/blacklist/fee-control bytecode
        selectors, owner renouncement, verified-source lookup)
  → research synthesis (Gemini, one structured call over everything gathered)
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
text context in the visual-classification prompt (see `src/ai/prompts.ts`).

The current 17 entries were built from real DexScreener screenshots the user categorized into
wins/losses, cross-referenced against live DexScreener search and on-chain checks (`src/research/
onchain.ts`) to ground each note in verifiable evidence rather than guessing from chart shape.
Two findings worth knowing if you extend this file:

- **On-chain contract mechanics (mint/pause/blacklist/owner) were uniformly clean across every
  single example, wins and losses alike.** None of the losses in this batch were rugs in the
  bytecode-exploit sense — the token launcher this chain's community uses appears to produce
  simple, immutable ERC-20s by default. So for *this* ecosystem, on-chain risk checks mostly
  won't distinguish a winner from a loser — don't expect `contractScore` to carry much signal by
  itself; liquidity ratio and clone/duplicate-name detection did far more of the differentiating
  work in practice.
- **What actually differed**: several losses showed liquidity at or above market cap (an inverted
  ratio vs. the healthier winners), a confirmed liquidity-drain (RH-VRF: pool liquidity collapsed
  from ~$7.2K to under $1 within minutes), and same-day duplicate/typosquat launches of the exact
  same name (Plinth, Scarce, HEIST, Flash AI all had 3-5 near-identical clones deployed within a
  same-day or same-hour window — including one homoglyph impersonation, `PLlNTH` with a lowercase
  L). Narrative sophistication did not predict outcome either way: the single most technically
  detailed pitch in the set (Flash AI's x402 agent-payments narrative) still failed within
  minutes, and a couple of "wins" were themselves down double digits at the moment they were
  captured — a win/loss label describes the outcome, not the mood of every chart snapshot.

Raw screenshot images live in `examples/wins/` and `examples/fails/` for your own reference — they
are **not** wired into any AI call (see the cost/latency note below on why not). If you want to
extend this further, a same-day duplicate-name check (query DexScreener search for the candidate's
name at classification time and flag if N near-identical pairs were created within a short window)
would be a cheap, evidence-backed addition to the scoring engine that this analysis suggests is
worth more than deeper on-chain contract checks for this specific chain.

## Trading extension (PAPER/SHADOW/LIVE)

The trading extension (`src/trading/`) turns qualified research candidates into trade plans,
entries, and exits — the full decision pipeline from the trading PRD, including live execution,
backtesting, and a lean learning layer. **Defaults to SHADOW and stays there unless you explicitly
set `TRADING_MODE=LIVE` and fund a wallet** — nothing here trades with real money by accident.

### What's built

- **Candidate generation** (`candidates.ts`): every token that clears the base pipeline's own
  WATCHLISTED/ALERTED bar becomes a `TradeCandidate`, evaluated immediately against the
  trading-specific gates (`MIN_TRADE_QUALITY_SCORE`, `_RESEARCH_CONFIDENCE`, `_CONTRACT_SCORE`,
  `_LIQUIDITY_USD`) — including ones that fail those gates, because a rejected candidate that
  later runs is exactly the data point §61 of the PRD wants captured.
- **Market/technical engine** (`marketAnalysis.ts`): DexScreener's public API has no OHLCV/candles
  endpoint, so this builds its own price/liquidity history from repeated polling of active
  candidates, and computes EMA/RSI-like momentum, swing high/low, drawdown, and liquidity ratios
  from it — honestly reporting `confidence: LOW` when a token is too new to have real history yet,
  rather than fabricating a 14-period RSI from 2 data points.
- **AI trade planning** (`planning.ts`, `schemas.ts`, `prompts.ts`): one structured Gemini call
  proposes a market regime and BUY_NOW/WAIT_FOR_ENTRY/WATCH_ONLY/REJECT_TRADE recommendation; a
  deterministic re-evaluation against **fresh** market data (liquidity moves between candidate
  creation and planning) can downgrade or reject whatever the AI proposed, but never upgrade a
  rejection — confirmed live: a test candidate was correctly rejected at planning when real
  liquidity had dropped below the threshold since it qualified, without ever calling the AI.
- **Risk engine** (`riskEngine.ts`, unit-tested — `yarn test`): candidate eligibility, position
  sizing (quality/confidence/risk/liquidity multipliers with hard caps), entry revalidation
  (catastrophic-drop detection, slippage/price-impact ceilings), ongoing position risk, and exit
  validation — all pure, deterministic functions, no AI involved in the actual gating.
- **Paper execution** (`execution.ts`): simulated fills using a standard constant-product AMM
  price-impact approximation against the pool's real, current DexScreener liquidity — not a real
  on-chain quote (per your call not to integrate a router yet).
- **Position manager** (`positionManager.ts`): PnL/MFE/MAE tracking, and every exit type from the
  PRD — staged profit-taking, trailing exit, technical invalidation, time exit, and an emergency
  risk exit that bypasses the normal slippage ceiling to avoid an orphaned position.
- **Portfolio accounting** (`portfolio.ts`): a simulated ledger starting from
  `PAPER_STARTING_BALANCE_USD`, capital buckets (reserve/deployable/available), and circuit
  breakers (max daily loss, consecutive losses, open positions) — checked before every new entry,
  never before an exit (exits must keep working while paused).
- **Postmortems, milestones, candidate-outcome tracking** (`postmortem.ts`, `milestones.ts`,
  `outcomes.ts`): every closed trade gets an AI postmortem; every candidate — traded or not — gets
  its market cap tracked at 15m/1h/6h/24h/48h checkpoints with 1.25x/1.5x/2x/2.5x hit flags, which
  is the actual learning dataset the whole extension exists to build (§61/§66).
- **Strategy versioning** (`strategy.ts`): a seeded `v1.0` version holds the sizing/entry/exit
  config as JSON; every plan and trade references its `strategyVersionId`; promotion
  (DRAFT→BACKTEST→SHADOW→PRODUCTION) is a manual API call only — nothing auto-promotes.
- **API** (`/trading/status`, `/trading/pause`, `/trading/resume`, `/trade-candidates`,
  `/trade-plans`, `/pending-entries`, `/positions`, `/trades`, `/portfolio`, `/ledger`,
  `/strategies`, `/learning/candidate-outcomes`, `/backtests`, `/learning/features`,
  `/learning/train`, `/learning/models`) — read-only plus pause/resume/promote/train/backtest;
  `/trading/status` also reports the live wallet address, its gas balance, and whether LIVE mode is
  actually ready to trade.
- Every email this extension sends is tagged `[PAPER]`/`[SHADOW]`/`[LIVE]` in the subject line, and
  entry/exit/closed-trade emails additionally say **"REAL"** and include the transaction hash when a
  fill was an actual on-chain trade — so a simulated trade can never be mistaken for a real one, or
  vice versa, in your inbox.

### Live execution (`src/trading/live/`)

Real Uniswap V4 swaps via the Universal Router on Robinhood Chain (chain ID 4663). This is the one
part of the whole project where a bug has real financial consequences, so it's built and verified
more conservatively than everything else:

- **Every contract address was verified against live bytecode** (`eth_getCode`) before being used
  anywhere, not trusted from documentation alone — see `contracts.ts`.
- **The swap calldata encoding was built from primary source, not memory or a summarized doc page.**
  Uniswap's own SDK docs admit their V4 coverage is incomplete, so this fetches the actual
  `Actions.sol`/`IV4Router.sol`/`PoolKey.sol`/`BaseActionsRouter.sol`/`V4SwapRouter.sol` source from
  GitHub and encodes the `V4_SWAP` command (single-hop `SWAP_EXACT_IN_SINGLE` + `SETTLE_ALL` +
  `TAKE_ALL`) directly with `viem`, matching those definitions field-for-field.
- **Pool discovery never assumes a fee tier or that hooks are absent** (`poolDiscovery.ts`) — it
  reads PoolManager's own `Initialize` events for the specific ETH/token pair, scanning backward in
  bounded chunks (Robinhood Chain produces a block every ~100ms, so `fromBlock: 0` times out on a
  public RPC — confirmed live). This matters: the first real token tested turned out to use a
  **custom hook contract**, which a naive "assume vanilla fee tiers" approach would have missed
  entirely and either failed to trade or built an incorrect PoolKey.
- **Verified end-to-end via a real, read-only `eth_call` simulation** against a live token with a
  real custom-hook pool on Robinhood Chain — the encoded transaction executed successfully
  (including the hook's own logic) without ever signing or spending anything. This is the strongest
  verification possible short of an actual funded trade.
- **Selling requires Permit2 approval** (`permit2Approvals.ts`) — confirmed against live
  `V4SwapRouter`/`Payments` source that ERC20 settlement pulls funds via Permit2's on-chain
  allowance, not a direct `transferFrom`. Approvals are short-lived (1 hour) and only submitted if
  actually insufficient, per §28's "prefer exact/limited approvals."
- **The signer is isolated** (`wallet.ts`) — the only module that ever reads
  `BOT_WALLET_PRIVATE_KEY`; every other module gets an address or a signing function, never the
  key. Every send is serialized through one in-process queue (nonce safety for a single process),
  chain ID is re-verified before every signature, and the router allowlist is enforced at the
  signer itself — not just upstream — so a bug anywhere else can't sign to an unvetted address.
- **A quote-then-execute split, always** (`executionFacade.ts`) — entry/exit revalidation checks a
  real Quoter-based estimate before ever calling the function that actually signs and sends;
  `client.call()` dry-runs the exact calldata one more time immediately before signing (§27's
  "simulation successful?" check — a revert here means the transaction is never signed).
- **PAPER/SHADOW/LIVE share the exact same trading-loop code** — `entryMonitor.ts`/
  `positionManager.ts` call through `executionFacade.ts`, which is the only place that branches on
  mode. Switching modes never touches planning, risk, or exit logic.

**To actually go live**: set `TRADING_MODE=LIVE` in `.env`, fund the generated wallet address (check
`GET /trading/status` for the address and current gas balance) with a small amount of ETH on
Robinhood Chain, and restart. Read §89-90 of the PRD first — shadow-test extensively before
trusting this with meaningful capital.

### Backtesting (`backtest.ts`) and learning (`learning.ts`)

- **Backtesting replays real historical data, never synthetic data.** `POST /backtests` takes an
  exit-rules configuration (defaults to the active strategy version) and replays it against every
  `CLOSED` trade's actual `PositionSnapshot` history, walking forward through the real timestamped
  price sequence and deciding exits using only that snapshot and earlier ones — the same
  no-lookahead constraint §70 requires. It can only backtest exit-rule *variations* on trades that
  were actually opened (they're the only rows with real snapshot-level history); it cannot yet
  simulate a hypothetical trade for a candidate that was never opened, since `CandidateOutcome`'s
  15m/1h/6h/24h/48h checkpoints aren't granular enough for that — documented as a gap, not silently
  approximated.
- **Learning is a lean, from-scratch logistic regression — deliberately not a heavyweight ML
  library.** §65 says "do not begin with deep learning," and §66's own data thresholds (`<50`
  candidates = analytics only) mean this system will spend a long time below the size where a real
  model means anything. `POST /learning/train` enforces that threshold in code, not just
  documentation: below 50 candidates it returns Pearson correlations between each feature and the
  outcome label (confirmed live: with 1 real candidate so far, every correlation correctly returns
  `null` rather than a fabricated number), and only trains an actual model once there's enough data
  — verified live, this path returns `coefficients: null` / `trainAccuracy: null` rather than
  overfitting a "model" to a single data point.
- **Neither backtesting nor learning outputs are ever read by `planning.ts` or `riskEngine.ts`.**
  Both are a recommendation surface only, exactly as the PRD specifies — a human decides whether a
  result ever becomes a new `StrategyVersion`.

### Deliberately deferred (not built)

- **Deployer/holder-reputation signals in position risk** — same missing-data-source limitation as
  the base research pipeline (no holder indexer).
- **Candidate-level (untraded) backtesting** — see the backtesting note above; would need
  snapshot-level history for candidates that were never actually opened as a trade.

### Known limitations (trading extension)

- **Technical indicators start cold.** A token discovered 10 minutes ago has 10 minutes of our own
  snapshot history, not weeks — EMA/RSI read `confidence: LOW` until enough snapshots accumulate.
  This is inherent to not having a real candles API, not a bug.
- **Neon's serverless free tier has real cold-start behavior.** Confirmed live: the first DB call
  after a period of inactivity can take 70-80 seconds to wake a suspended compute, and can
  occasionally exceed the connection attempt's own timeout and fail outright even though the exact
  same call succeeds in ~1s once warm. Both the base app's startup and the trading orchestrator's
  startup now retry through this (`src/util/retry.ts`), and every single Prisma call anywhere in
  the app also retries automatically on a transient connection error (`src/db.ts`, confirmed live —
  found scattered `ETIMEDOUT`/connection-reset errors surfacing from unrelated queries at random
  points during normal operation, not just at startup). If you deploy to a VPS instead of Neon,
  this class of problem mostly goes away.

## Known limitations (base research pipeline)

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
