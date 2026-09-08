# PRD — Robinhood Chain Utility Token Discovery & Research Agent

**Document Version:** 1.0
**Status:** Build Ready
**Primary Stack:** TypeScript, Node.js, PostgreSQL, Redis/BullMQ, Playwright, `viem`
**Primary Deployment Model:** 24/7 Dockerized worker(s) on a VPS / long-running cloud service
**Primary Signal Source:** DexScreener recently updated / latest token profile feeds
**Initial Chain:** Robinhood Chain
**Primary User:** Active early-stage utility-token trader

---

# 1. Product Summary

## 1.1 Product Name

Working name:

**UtilityScout**

Alternative internal names:

- RH Scout
- SignalForge
- Utility Radar
- Project Scout
- Token Intel Agent

The name is not important for MVP implementation.

---

## 1.2 One-Sentence Description

UtilityScout is a 24/7 automated agent that monitors new and recently updated Robinhood Chain tokens, filters out likely memecoins using visual and metadata analysis, performs deeper project, market, social, website, and on-chain research on promising candidates, scores them, and sends high-quality opportunities to the user by email.

---

# 2. Problem Statement

The user currently finds a large percentage of promising trades through DexScreener's **Recently Updated Token Info** panel.

The current workflow is manual:

1. Open DexScreener.
2. Watch the recently updated token panel.
3. Identify Robinhood Chain tokens.
4. Visually inspect the token icon and name.
5. Decide whether the project looks like a utility project or a memecoin.
6. Open the token page.
7. Check DexScreener links.
8. Visit the website.
9. Visit the X account.
10. Determine what the project does.
11. Check whether the project looks legitimate.
12. Check market activity.
13. Decide whether to buy.

This process has several problems:

- It requires constant manual monitoring.
- Good opportunities may appear while the user is asleep or offline.
- Research needs to happen quickly because early-stage token opportunities move fast.
- Many tokens are obvious low-quality memes that do not deserve deep research.
- A professional-looking project can still be unsafe or fake.
- Human attention is inconsistent.
- The user does not want to keep a laptop running 24/7.

UtilityScout should automate this workflow while preserving the user's final decision.

---

# 3. Product Goal

The system should continuously identify **potentially legitimate utility-focused token projects as early as possible** on Robinhood Chain and surface only the highest-quality opportunities.

The system should optimize for:

- Early detection
- Low false-positive rate
- Fast research turnaround
- Strong utility-project classification
- Scam/risk filtering
- Useful explanations
- Minimal manual monitoring
- 24/7 server-side operation

---

# 4. Non-Goals

The MVP will **not**:

- Automatically buy tokens.
- Automatically sell tokens.
- Connect directly to the user's wallet for trading.
- Guarantee returns.
- Predict exact future token prices.
- Treat branding alone as proof of legitimacy.
- Scrape every possible blockchain and social platform from day one.
- Attempt to fully replace human investment judgment.
- Monitor Solana, BSC, Base, or Ethereum in V1.
- Build a mobile application in V1.
- Build a complex quantitative trading strategy.

Automatic execution may be considered in a future version only after the discovery and scoring system has been extensively validated.

---

# 5. Core Product Principle

The system must use a **progressive research funnel**.

It should not deeply research every token.

The funnel should be:

```text
New Token Detected
        ↓
Robinhood Chain?
        ↓
Previously Seen?
        ↓
Cheap Metadata Filter
        ↓
Visual / Name / Branding Filter
        ↓
Potential Utility Project?
        ↓
Deep Research
        ↓
On-Chain Risk Checks
        ↓
Market Quality Checks
        ↓
Project / Website / Social Research
        ↓
Score
        ↓
Threshold Reached?
        ↓
Email Alert
```

This keeps the system fast and reduces AI/API costs.

---

# 6. Primary User Story

> As a trader focused on early utility-token opportunities on Robinhood Chain, I want a server-side agent to continuously monitor newly surfaced tokens, eliminate obvious memecoins and low-quality projects, deeply research the promising ones, and email me when a project crosses my configured quality threshold so that I can investigate and act quickly without manually watching DexScreener all day.

---

# 7. Success Criteria

The MVP is successful if:

1. The agent runs continuously for at least 7 days without manual intervention.
2. The agent detects new Robinhood Chain entries from the target DexScreener signal source.
3. Duplicate tokens are not repeatedly researched.
4. Obvious memecoins are rejected before expensive research.
5. Promising projects are deeply researched automatically.
6. The complete research process typically finishes within 2 minutes of detection.
7. High-scoring opportunities generate an email alert.
8. Every alert contains enough information for the user to make an informed decision.
9. Every score is explainable through stored factors.
10. The system stores historical results for later backtesting and calibration.

---

# 8. MVP Scope

## 8.1 Included

### Token Discovery

- Poll DexScreener latest/recent token-profile feeds.
- Filter for Robinhood Chain.
- Detect newly seen token addresses.
- Store token discovery timestamp.
- Queue tokens for classification.

### Initial Filtering

- Inspect:
  - Token name
  - Symbol
  - Icon
  - Header image where available
  - Description
  - DexScreener profile links
- Classify likely:
  - Utility project
  - Meme project
  - Unknown / ambiguous
- Score visual professionalism.
- Score utility likelihood.
- Compare candidate characteristics against known successful and unsuccessful examples.

### Deep Research

For tokens passing the initial filter:

- Retrieve DexScreener market data.
- Retrieve token/pair data.
- Visit project website.
- Analyze website content.
- Inspect available social links.
- Research X presence.
- Inspect documentation where available.
- Inspect GitHub where available.
- Analyze project utility.
- Analyze whether token utility is credible.
- Perform on-chain contract risk checks.
- Analyze liquidity and market activity.
- Produce structured scoring output.

### Notification

- Send an email when a token passes the configured alert threshold.
- Include:
  - Token
  - Ticker
  - Contract address
  - Score
  - Project summary
  - Why it passed
  - Risks
  - Market data
  - Important links
  - Detection time
  - Research completion time

### Administration

Minimal internal dashboard or API endpoints for:

- Recent detections
- Research results
- Rejected tokens
- Alerted tokens
- Model scores
- System health

---

# 9. Future Scope

Possible future versions:

- Solana support
- Base support
- BSC support
- Ethereum support
- Direct Robinhood Chain new-pair monitoring
- Contract creation event monitoring
- X project-launch monitoring
- Telegram alerts
- Discord alerts
- Push notifications
- SMS alerts
- User-configurable scoring weights
- Automated watchlists
- Price tracking after alert
- Historical performance evaluation
- ML-based scoring calibration
- Wallet/deployer reputation graph
- Smart-money wallet monitoring
- Founder identity graph
- GitHub activity scoring
- Autonomous trading with strict risk controls
- Multi-user SaaS

---

# 10. Functional Requirements

# FR-001 — Continuous DexScreener Monitoring

The system must continuously poll configured DexScreener endpoints.

### Requirements

- Poll interval must be configurable.
- Default recommended interval: 15 seconds.
- The system must obey API rate limits.
- Each returned token must be normalized.
- Tokens not on Robinhood Chain must be ignored for V1.
- API failures must retry with backoff.
- Poller failures must not crash the whole service.

### Example

```ts
interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: {
    type?: string;
    label?: string;
    url: string;
  }[];
}
```

The exact provider response shape should be wrapped inside an adapter so provider changes do not affect the rest of the application.

---

# FR-002 — Robinhood Chain Filtering

A discovered profile should only proceed if it belongs to Robinhood Chain.

The exact DexScreener chain identifier must be configurable:

```env
TARGET_CHAIN_ID=robinhood
```

Do not spread provider-specific chain strings throughout the codebase.

---

# FR-003 — Duplicate Detection

Before processing a token, the system must determine whether it has already been seen.

Unique identity:

```text
chain + token contract address
```

If already processed:

- Update `lastSeenAt`.
- Optionally refresh market data.
- Do not perform full research again unless a refresh rule applies.

Example refresh rules:

- Never re-run full research within 6 hours.
- Re-run when major profile metadata changes.
- Re-run when project links are newly added.
- Re-run when token crosses a market-cap/liquidity threshold.

---

# FR-004 — Initial Metadata Filter

Before calling an expensive vision or research workflow, run inexpensive checks.

Possible rejection signals:

- Missing name.
- Missing icon.
- Obviously invalid contract metadata.
- Previously blacklisted token.
- Duplicate cloned token.
- Known spam naming pattern.
- Clearly meme-only terms where confidence is high.

Do not reject solely because of a single keyword.

---

# FR-005 — Image and Branding Analysis

The system must submit candidate visual data to a multimodal model.

Inputs may include:

- Token icon
- DexScreener header image
- Name
- Ticker
- Description

The model must return structured JSON.

Example:

```json
{
  "utilityProbability": 0.82,
  "memeProbability": 0.14,
  "brandingQuality": 0.88,
  "professionalism": 0.79,
  "visualSpamProbability": 0.06,
  "requiresResearch": true,
  "reasoningSummary": [
    "Branding resembles a software/product company rather than a meme token",
    "Name is technical but not obviously meme-oriented",
    "Visual identity appears purpose-built rather than template spam"
  ]
}
```

---

# FR-006 — Reference Examples

The user must be able to maintain labeled reference examples.

Categories:

```text
WINNER_UTILITY
LOSER_UTILITY
MEME
SCAM
AMBIGUOUS
```

Each example should optionally contain:

- Name
- Symbol
- Image
- Contract
- Notes
- Peak multiple
- Why it was considered good/bad
- Project category
- Entry market cap
- Peak market cap
- Liquidity at entry

The system should use these examples as context for image/branding classification.

V1 can use prompt examples.

V2 can use image/text embeddings for similarity search.

---

# FR-007 — Initial Filter Threshold

Only tokens that pass the initial classification should proceed to deep research.

Config:

```env
MIN_UTILITY_PROBABILITY=0.65
MAX_MEME_PROBABILITY=0.45
MIN_BRANDING_SCORE=0.45
```

A high utility probability should be more important than branding quality.

A mediocre-looking but legitimate project must not automatically fail because the logo is unattractive.

---

# FR-008 — Research Job Creation

Passing tokens must create a `research_job`.

States:

```text
PENDING
RUNNING
COMPLETED
FAILED
RETRYING
REJECTED
```

Jobs must be processed asynchronously through a queue.

Recommended:

- BullMQ
- Redis

Queues:

```text
discovery
classification
research
browser
onchain
notifications
```

They may initially be implemented with fewer physical queues while preserving logical separation in code.

---

# FR-009 — DexScreener Market Research

The research agent should collect, where available:

- Token price
- Market cap
- FDV
- Liquidity
- 5m volume
- 1h volume
- 6h volume
- 24h volume
- 5m buys
- 5m sells
- 1h buys
- 1h sells
- Pair creation time
- Price changes
- DEX
- Pair address
- Quote token
- Boost status
- Available website links
- Available social links

The raw provider response should be stored for debugging.

---

# FR-010 — Website Research

If the project has a website, the system should visit it.

Primary implementation:

**Playwright + headless Chromium**

Research should extract:

- Title
- Meta description
- Visible page text
- Navigation labels
- Linked documentation
- App links
- GitHub links
- Team links
- Social links
- Roadmap
- Whitepaper
- Product descriptions

The browser must:

- Use sensible timeouts.
- Block unnecessary heavy assets where possible.
- Retry failed pages.
- Detect redirects.
- Detect obviously parked domains.
- Detect error pages.

---

# FR-011 — Website Credibility Analysis

The AI research layer should answer:

1. What does the project claim to do?
2. What user problem does it solve?
3. Is there a real product?
4. Is there a usable app/demo?
5. Are there technical docs?
6. Is there a GitHub repository?
7. Is the roadmap credible?
8. Does the website appear copied or generic?
9. Does the token have a plausible role?
10. Are claims verifiable?
11. Are partnerships mentioned?
12. Can those partnerships be verified?
13. Does the project appear to have existed before the token?
14. Is the site mostly buzzwords with little substance?

Structured output:

```json
{
  "productExists": true,
  "productMaturity": 0.62,
  "utilityCredibility": 0.83,
  "websiteQuality": 0.76,
  "docsQuality": 0.67,
  "tokenUtilityClarity": 0.71,
  "redFlags": [],
  "summary": "..."
}
```

---

# FR-012 — X / Social Research

The system should inspect the project's available social presence.

Priority:

1. X
2. GitHub
3. Telegram/Discord metadata where practical
4. General indexed web presence

The system should evaluate:

- Account age if available
- Follower count
- Posting history
- Whether project history predates token launch
- Engagement quality
- Whether activity appears bot-driven
- Developer/founder references
- Product announcements
- Community discussion
- Prior project mentions
- Contradictory branding
- Recently created social accounts

V1 does not require perfect social-data coverage.

Unavailable data must be represented as `unknown`, not fabricated.

---

# FR-013 — Web Search Research

For qualifying projects, the system should perform search-engine research.

Queries may include:

```text
"<project name>"
"<project name>" crypto
"<project name>" token
"<project name>" GitHub
"<project name>" scam
"<project name>" founder
"<project name>" funding
"<project domain>"
"<contract address>"
```

Goals:

- Find project history.
- Find old references predating token launch.
- Find independent discussions.
- Verify claims.
- Identify warnings.
- Find GitHub.
- Find founders.
- Identify copied projects.

---

# FR-014 — Robinhood Chain On-Chain Analysis

Use EVM-compatible tooling such as `viem`.

The on-chain module should collect, where possible:

- Token contract bytecode
- Contract creation transaction
- Deployer
- Owner
- Proxy status
- Implementation address
- Total supply
- Token decimals
- Symbol/name
- Ownership privileges
- Mint capability
- Pause capability
- Blacklist capability
- Fee/tax controls
- Upgradeability
- Unusual transfer restrictions

Some checks may require static contract analysis or third-party security services.

Every check must distinguish between:

```text
PASS
FAIL
UNKNOWN
NOT_APPLICABLE
```

Unknown must never be silently interpreted as safe.

---

# FR-015 — Holder Distribution

If reliable holder data is available, collect:

- Number of holders
- Top holder %
- Top 5 %
- Top 10 %
- LP addresses
- Contract-held balance
- Burned balance
- Deployer balance
- Team-linked wallets where identifiable

The system must avoid treating LP/router/system addresses as ordinary whales.

---

# FR-016 — Deployer Reputation

Where practical, inspect the deployer address.

Potential signals:

- Previous contracts deployed
- Previous token launches
- Repeated abandoned tokens
- Reused wallets
- Known scam labels
- Funding source
- Existing project history

V1 may store raw deployer data and perform limited heuristics.

---

# FR-017 — Liquidity Analysis

The market-risk module should evaluate:

- Absolute liquidity
- Liquidity/market-cap ratio
- Liquidity growth
- Pair age
- Whether liquidity is unusually low
- Whether market cap is high relative to liquidity
- Whether one pool dominates liquidity

Suggested minimum configurable rules:

```env
MIN_LIQUIDITY_USD=15000
MIN_LIQUIDITY_TO_MCAP_RATIO=0.04
```

These should not be hard-coded.

---

# FR-018 — Trading Activity Analysis

Evaluate:

- Buys vs sells
- Recent volume
- Volume relative to liquidity
- Sudden activity spikes
- Price acceleration
- Number of transactions
- Concentration of activity
- Token age

The system should avoid using momentum as the primary utility signal.

Momentum is a market-quality factor, not proof of legitimacy.

---

# FR-019 — Project Utility Classification

Every researched token must be assigned a primary project class.

Example taxonomy:

```text
AI
DEFI
TRADING
INFRASTRUCTURE
DATA
IDENTITY
GAMING
SOCIAL
PAYMENTS
RWA
DEVELOPER_TOOLS
SECURITY
PRIVACY
STORAGE
COMPUTE
DAO
MARKETPLACE
OTHER_UTILITY
MEME
UNKNOWN
```

This classification will later help identify which categories perform best.

---

# FR-020 — Final Scoring Engine

Final score must be primarily deterministic.

LLMs may generate factor scores, but final weighting must occur in application code.

Recommended V1 weights:

| Category | Weight |
|---|---:|
| Real Product / Utility | 20 |
| Contract Safety | 15 |
| Project History / Credibility | 10 |
| Website / Docs Quality | 10 |
| Social Legitimacy | 10 |
| Liquidity Quality | 10 |
| Market Activity | 8 |
| Holder Distribution | 7 |
| Team / GitHub | 5 |
| Branding / Visual Quality | 5 |
| **Total** | **100** |

Example:

```ts
const finalScore =
  utility * 0.20 +
  contractSafety * 0.15 +
  credibility * 0.10 +
  website * 0.10 +
  social * 0.10 +
  liquidity * 0.10 +
  market * 0.08 +
  holders * 0.07 +
  team * 0.05 +
  branding * 0.05;
```

All factor scores should use a common `0-100` scale.

---

# FR-021 — Hard Rejection Rules

Some conditions should override a high AI score.

Examples:

- Confirmed malicious contract behavior.
- Honeypot behavior.
- Unrestricted hidden mint capability with suspicious ownership.
- Transfer restrictions preventing normal selling.
- Extremely concentrated supply.
- Website confirmed to impersonate another project.
- Contract address does not match official project sources.
- Clearly fake project identity.
- Known malicious deployer.
- Liquidity below configured emergency minimum.

Hard rejection must be explainable and logged.

---

# FR-022 — Score Bands

Default:

```text
0–49     REJECT
50–64    LOW QUALITY
65–74    WATCH
75–84    STRONG WATCH
85–100   HIGH CONVICTION CANDIDATE
```

The labels must be configurable.

The system should not represent the score as a guarantee of future price performance.

---

# FR-023 — Email Alert

An email must be sent when:

```text
finalScore >= ALERT_THRESHOLD
AND
hardReject == false
```

Default:

```env
ALERT_THRESHOLD=85
```

Subject example:

```text
🚨 RH Utility Candidate — NAVIER — 89/100
```

Body should contain:

```text
Project: Navier-Stokes
Ticker: NAVIER
Contract: 0x...
Score: 89/100

Detected: 08:43:12
Research completed: 08:44:03

WHY IT PASSED
• Existing product
• Project presence predates token
• Active social footprint
• Good initial liquidity
• No major contract risk found

RISKS
• Top 10 holders own 28%
• Token is less than one hour old
• Liquidity remains relatively low

MARKET
Market cap: $...
Liquidity: $...
5m volume: $...
1h volume: $...
Buys/Sells: ...

SCORES
Utility: 94
Contract: 91
Credibility: 88
Website: 86
Social: 83
Liquidity: 78
Market: 82
Holders: 74
Team: 85
Branding: 91

LINKS
DexScreener
Website
X
GitHub
Explorer
```

---

# FR-024 — Alert Deduplication

Do not email repeatedly for the same token unless:

- The score crosses a major configured threshold.
- A significant new risk is detected.
- A watchlisted token later becomes a high-quality candidate.
- User explicitly enables repeated updates.

---

# FR-025 — Watchlist

Tokens scoring between the configured watchlist threshold and alert threshold should be stored.

Example:

```env
WATCHLIST_THRESHOLD=70
ALERT_THRESHOLD=85
```

Watchlisted tokens can optionally be automatically rechecked after:

- 15 minutes
- 1 hour
- 6 hours

---

# FR-026 — Post-Alert Performance Tracking

This should be implemented if practical in MVP because it is critical for improving the system.

For every alerted/watchlisted token, record:

- Price at detection
- Market cap at detection
- Liquidity at detection
- Price after 15m
- Price after 1h
- Price after 6h
- Price after 24h
- Price after 48h
- Maximum observed gain
- Maximum observed drawdown

This allows the user to determine whether the scoring system actually works.

---

# 11. AI Architecture

The AI system should be split into specialized tasks instead of one giant prompt.

Recommended agents/modules:

```text
1. VisualClassifier
2. WebsiteResearcher
3. SocialResearcher
4. UtilityAnalyst
5. RiskSummarizer
6. FinalResearchSynthesizer
```

The actual implementation may use the same model for multiple roles.

---

# 12. AI Output Contract

Every AI call must return structured data validated with Zod.

Example:

```ts
import { z } from "zod";

export const VisualClassificationSchema = z.object({
  utilityProbability: z.number().min(0).max(1),
  memeProbability: z.number().min(0).max(1),
  brandingQuality: z.number().min(0).max(1),
  professionalism: z.number().min(0).max(1),
  visualSpamProbability: z.number().min(0).max(1),
  requiresResearch: z.boolean(),
  reasoningSummary: z.array(z.string()).max(8),
});
```

Never depend on free-form model output for core application logic.

---

# 13. Example Visual Classification Prompt

System intent:

```text
You classify newly surfaced crypto token projects.

The user's strategy specifically seeks legitimate utility/product projects and wants to reject obvious memecoins, joke projects, imitation projects, and low-effort launches.

Do not assume professional branding means the project is legitimate.

At this stage, only evaluate whether the project deserves further research.

Use the provided positive and negative reference examples when available.

Return structured JSON only.
```

Evaluation dimensions:

```text
- Does the token visually resemble a product/startup/protocol?
- Is the name primarily meme/joke/cultural?
- Does the branding resemble generic AI-generated token spam?
- Does the visual identity appear consistent?
- Is there enough evidence to justify deeper research?
```

---

# 14. Example Utility Research Prompt

The utility analyst should receive:

- Website text
- Documentation text
- Search findings
- Social findings
- Token metadata
- Project links

It should answer:

```text
1. What does the project actually do?
2. What user problem does it solve?
3. What evidence exists that the product works?
4. Does the project appear older than the token?
5. Does the token have a meaningful role?
6. Could the same project operate without a token?
7. Are there independent references?
8. What claims are unverifiable?
9. What are the strongest red flags?
10. Assign a 0-100 utility credibility score.
```

---

# 15. System Architecture

Recommended:

```text
                     ┌─────────────────────┐
                     │    DexScreener      │
                     └──────────┬──────────┘
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ Discovery Worker        │
                  │ Node.js / TypeScript    │
                  └─────────────┬────────────┘
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ PostgreSQL Dedup Check  │
                  └─────────────┬────────────┘
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ Classification Queue    │
                  └─────────────┬────────────┘
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ Visual AI Classifier    │
                  └─────────────┬────────────┘
                                │
                          PASS / FAIL
                                │
                                ▼
              ┌───────────────────────────────────┐
              │         Research Queue         │
              └────────────────┬───────────────────┘
                              │
        ┌──────────────────────┼───────────────────────┐
        ▼                    ▼                    ▼
┌────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Dex Research │    │ Website/Social │    │ On-chain      │
│ APIs         │    │ Playwright     │    │ viem          │
└───────┬────────┘    └────────┬─────────┘    └────────┬─────────┘
       │                    │                     │
        ───────────────────────┼───────────────────────
                             ▼
                ┌───────────────────────────┐
                │ Research Synthesizer   │
                └─────────────┬─────────────┘
                             ▼
                ┌───────────────────────────┐
                │ Deterministic Scoring  │
                └─────────────┬─────────────┘
                              │
                     score >= threshold
                              │
                              ▼
                ┌───────────────────────────┐
                │ Resend Email Alert     │
                └───────────────────────────┘
```

---

# 16. Recommended Repository Structure

```text
utility-scout/
├── apps/
│   ├── api/
│   │   └── src/
│   ├── worker/
│   │   └── src/
│   └── dashboard/
│       └── src/
│
├── packages/
│   ├── db/
│   │   ├── prisma/
│   │   └── src/
│   ├── dex/
│   ├── blockchain/
│   ├── ai/
│   ├── browser/
│   ├── scoring/
│   ├── notifications/
│   ├── queue/
│   ├── shared/
│   └── config/
│
├── examples/
│   ├── winner-utility/
│   ├── loser-utility/
│   ├── meme/
│   └── scam/
│
├── docker/
├── scripts/
├── docs/
├── docker-compose.yml
├── package.json
└── README.md
```

A monorepo using `pnpm` workspaces or Turborepo is recommended.

---

# 17. Suggested Technology Stack

## Backend

- Node.js
- TypeScript
- Fastify or Express
- Zod
- Prisma

## Database

- PostgreSQL

## Queue

- Redis
- BullMQ

## Blockchain

- `viem`

## Browser Automation

- Playwright
- Chromium

## AI

Use a provider abstraction:

```ts
interface AIProvider {
  classifyVisual(input: VisualInput): Promise<VisualResult>;
  analyzeResearch(input: ResearchInput): Promise<ResearchResult>;
}
```

This avoids locking the application to one model vendor.

## Email

- Resend

## Logging

- Pino

## Monitoring

Initial:

- Health endpoint
- Structured logs

Recommended later:

- Sentry
- Better Uptime
- Grafana/Prometheus

## Deployment

Preferred MVP:

- DigitalOcean VPS
- Docker Compose

Alternative:

- Railway
- Render background workers
- Fly.io

Dashboard can be deployed separately to Vercel.

---

# 18. Database Schema

Suggested Prisma models.

```prisma
model Token {
  id                 String   @id @default(cuid())
  chain              String
  address            String
  name               String?
  symbol             String?
  iconUrl             String?
  headerUrl           String?
  description         String?

  firstSeenAt         DateTime @default(now())
  lastSeenAt          DateTime @updatedAt

  utilityClass        String?
  status              TokenStatus @default(DETECTED)

  profiles            TokenProfile[]
  classifications     Classification[]
  researchRuns        ResearchRun[]
  marketSnapshots     MarketSnapshot[]
  alerts              Alert[]

  @@unique([chain, address])
}

enum TokenStatus {
  DETECTED
  REJECTED
  CLASSIFIED
  RESEARCHING
  WATCHLISTED
  ALERTED
  FAILED
}

model TokenProfile {
  id          String   @id @default(cuid())
  tokenId     String
  token       Token    @relation(fields: [tokenId], references: [id])
  rawData     Json
  createdAt   DateTime @default(now())
}

model Classification {
  id                    String   @id @default(cuid())
  tokenId               String
  token                 Token    @relation(fields: [tokenId], references: [id])

  utilityProbability    Float
  memeProbability       Float
  brandingQuality       Float
  professionalism       Float
  spamProbability       Float
  passed                 Boolean
  reasons                Json

  model                  String?
  promptVersion          String?
  createdAt              DateTime @default(now())
}

model ResearchRun {
  id                 String   @id @default(cuid())
  tokenId            String
  token              Token    @relation(fields: [tokenId], references: [id])

  status             ResearchStatus
  startedAt          DateTime?
  completedAt        DateTime?

  websiteScore       Float?
  utilityScore       Float?
  contractScore      Float?
  credibilityScore   Float?
  socialScore        Float?
  liquidityScore     Float?
  marketScore        Float?
  holderScore        Float?
  teamScore          Float?
  brandingScore      Float?
  finalScore         Float?

  hardReject         Boolean  @default(false)
  rejectionReasons  Json?
  summary            String?
  risks              Json?
  positives          Json?
  rawResearch        Json?

  createdAt          DateTime @default(now())
}

enum ResearchStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  RETRYING
}

model MarketSnapshot {
  id             String   @id @default(cuid())
  tokenId        String
  token          Token    @relation(fields: [tokenId], references: [id])

  priceUsd       Decimal?
  marketCapUsd   Decimal?
  fdvUsd         Decimal?
  liquidityUsd   Decimal?

  volume5m       Decimal?
  volume1h       Decimal?
  volume6h       Decimal?
  volume24h      Decimal?

  buys5m         Int?
  sells5m        Int?
  buys1h         Int?
  sells1h        Int?

  priceChange5m  Float?
  priceChange1h  Float?

  capturedAt     DateTime @default(now())
}

model ProjectLink {
  id        String   @id @default(cuid())
  tokenId   String
  type      String
  url       String
  source    String?
  createdAt DateTime @default(now())
}

model Alert {
  id          String   @id @default(cuid())
  tokenId     String
  token       Token    @relation(fields: [tokenId], references: [id])

  type        String
  score       Float?
  recipient   String
  providerId  String?
  sentAt      DateTime @default(now())
}

model ReferenceExample {
  id            String   @id @default(cuid())
  category      ReferenceCategory
  name          String?
  symbol        String?
  imageUrl      String?
  localPath     String?
  contract      String?
  notes         String?
  entryMcap     Decimal?
  peakMcap      Decimal?
  peakMultiple  Float?
  createdAt     DateTime @default(now())
}

enum ReferenceCategory {
  WINNER_UTILITY
  LOSER_UTILITY
  MEME
  SCAM
  AMBIGUOUS
}
```

`ProjectLink` can also be attached through a direct relation to `Token` in the final schema.

---

# 19. Internal API

Suggested endpoints:

```text
GET /health

GET /tokens
GET /tokens/:id
GET /tokens/:id/research
GET /tokens/:id/market

GET /alerts
GET /watchlist
GET /rejected

POST /tokens/:id/research
POST /tokens/:id/reclassify

GET /reference-examples
POST /reference-examples
DELETE /reference-examples/:id

GET /settings
PATCH /settings
```

Authentication can be a simple private admin key for the first internal version.

---

# 20. Configuration

Example:

```env
NODE_ENV=production

DATABASE_URL=
REDIS_URL=

DEXSCREENER_BASE_URL=
TARGET_CHAIN_ID=robinhood
DISCOVERY_INTERVAL_SECONDS=15

RH_RPC_URL=

AI_PROVIDER=
AI_API_KEY=

SEARCH_API_KEY=

RESEND_API_KEY=
ALERT_EMAIL_FROM=
ALERT_EMAIL_TO=

MIN_UTILITY_PROBABILITY=0.65
MAX_MEME_PROBABILITY=0.45
MIN_BRANDING_SCORE=0.45

WATCHLIST_THRESHOLD=70
ALERT_THRESHOLD=85

MIN_LIQUIDITY_USD=15000
MIN_LIQUIDITY_TO_MCAP_RATIO=0.04

WEBSITE_TIMEOUT_MS=15000
RESEARCH_TIMEOUT_SECONDS=120
```

Secrets must not be committed to Git.

---

# 21. Queue Design

## Discovery Queue

Input:

```json
{
  "chain": "robinhood",
  "address": "0x..."
}
```

Output:

- normalized token record

## Classification Queue

Input:

```json
{
  "tokenId": "..."
}
```

Output:

- classification result
- pass/fail

## Research Queue

Runs only after classification passes.

Subtasks:

```text
market research
website research
social research
on-chain research
search research
```

These may run concurrently.

## Notification Queue

Input:

```json
{
  "tokenId": "...",
  "researchRunId": "..."
}
```

Sends email and records result.

---

# 22. Research Orchestration

Example:

```ts
const [
  market,
  website,
  socials,
  onchain,
  webResearch
] = await Promise.allSettled([
  researchMarket(token),
  researchWebsite(token),
  researchSocials(token),
  researchOnchain(token),
  researchWeb(token),
]);
```

The whole research job should not fail because one research source is unavailable.

Each subsystem must return:

```text
SUCCESS
FAILED
UNAVAILABLE
PARTIAL
```

---

# 23. Browser Safety and Reliability

Playwright should run server-side.

Recommended browser settings:

- Headless mode.
- Fresh browser context per project.
- Disable downloads.
- Block pop-ups.
- Restrict navigation.
- Limit page count.
- Time out slow websites.
- Prevent unbounded browsing loops.
- Do not execute project-provided downloads.
- Do not connect wallets.
- Do not sign transactions.
- Do not submit forms unless explicitly required in a future feature.

Browser navigation should only be used for research.

---

# 24. Scoring Details

## Utility Score — 20%

Consider:

- Working product
- Clear problem
- Real use case
- Technical substance
- Token utility
- Existing users
- Product predates token

## Contract Safety — 15%

Consider:

- Mint
- Blacklist
- Pausing
- Taxes
- Upgradeability
- Owner controls
- Transfer restrictions
- Honeypot indicators

## Credibility — 10%

Consider:

- Project history
- Independent mentions
- Founder history
- Consistent branding
- Prior existence

## Website / Docs — 10%

Consider:

- Real docs
- Technical details
- Functional pages
- App/demo
- Original content
- Domain quality

## Social — 10%

Consider:

- Account history
- Organic engagement
- Historical posts
- Community
- Credible developers

## Liquidity — 10%

Consider:

- Absolute liquidity
- Market-cap relationship
- Stability
- Pool depth

## Market Activity — 8%

Consider:

- Volume
- Buys/sells
- Transactions
- Price movement

## Holders — 7%

Consider:

- Concentration
- Team balances
- Deployer balances
- Whale concentration

## Team / GitHub — 5%

Consider:

- Identifiable builders
- Repository quality
- Commit activity
- Existing code

## Branding — 5%

Consider:

- Professionalism
- Consistency
- Non-meme appearance
- Similarity to successful utility references

---

# 25. Missing Data Rules

Missing information should not automatically become `0`.

Example:

If GitHub is unavailable:

```text
teamScoreConfidence = LOW
```

rather than:

```text
teamScore = 0
```

Each scored factor should ideally contain:

```json
{
  "score": 72,
  "confidence": 0.61,
  "dataAvailability": "PARTIAL"
}
```

Final scoring can optionally apply a confidence penalty.

---

# 26. Confidence Score

Separate:

```text
QUALITY SCORE
```

from:

```text
RESEARCH CONFIDENCE
```

Example:

```text
Quality: 88/100
Confidence: 72/100
```

A token may look excellent while the agent has very little data.

This distinction is important.

---

# 27. Alert Logic

Recommended:

```ts
if (
  research.finalScore >= config.alertThreshold &&
  research.confidence >= 60 &&
  !research.hardReject
) {
  await enqueueAlert(research);
}
```

A future version may use different thresholds based on token age.

---

# 28. Dashboard

The dashboard is useful but not required before the worker is operational.

Recommended pages:

## Overview

- Tokens detected today
- Utility candidates
- Research jobs
- Watchlisted
- Alerts
- Rejections
- Errors

## Feed

Table:

```text
Time
Token
Ticker
Classification
Score
Liquidity
Market Cap
Status
```

## Token Detail

Show:

- Visual
- Metadata
- Research summary
- Scores
- Risks
- Links
- Raw evidence
- Market timeline

## Reference Library

Allow user to upload examples and label:

- Winner
- Loser
- Meme
- Scam

## Settings

Allow editing:

- Alert threshold
- Utility threshold
- Liquidity threshold
- Poll interval
- Email address

---

# 29. Error Handling

The system must gracefully handle:

- DexScreener downtime
- Missing images
- Broken image URLs
- AI timeout
- AI malformed JSON
- Website timeout
- Website blocking automation
- X unavailable
- RPC unavailable
- Database downtime
- Redis downtime
- Email failure
- Invalid project URLs
- DNS errors

Retries should use exponential backoff.

Example:

```text
attempt 1: immediate
attempt 2: 5 seconds
attempt 3: 30 seconds
attempt 4: 2 minutes
```

Permanent failures must be logged.

---

# 30. Observability

Each token should have a correlation ID.

Log:

```text
token detected
classification started
classification completed
research started
market research completed
website research completed
social research completed
onchain research completed
score calculated
alert sent
```

Example structured log:

```json
{
  "level": "info",
  "event": "research.completed",
  "tokenId": "...",
  "address": "0x...",
  "durationMs": 48731,
  "score": 88
}
```

---

# 31. Health Checks

Expose:

```text
GET /health
```

Response:

```json
{
  "status": "ok",
  "database": "ok",
  "redis": "ok",
  "poller": "ok",
  "lastDiscoveryPoll": "2026-09-08T08:44:31Z"
}
```

A monitoring service should alert if the worker stops polling.

---

# 32. Deployment

Recommended MVP infrastructure:

```text
DigitalOcean VPS
Ubuntu
Docker
Docker Compose

Containers:
- api
- worker
- redis
- optional dashboard

Managed / external:
- PostgreSQL
- AI provider
- email provider
```

Example `docker-compose.yml` concept:

```yaml
services:
  api:
    build: .
    command: pnpm start:api
    restart: unless-stopped

  worker:
    build: .
    command: pnpm start:worker
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped
```

Use persistent data volumes where necessary.

---

# 33. Deployment Principle

The monitoring worker must **not depend on the user's laptop**.

Correct:

```text
Cloud VPS
    ↓
Node worker
    ↓
DexScreener/API
    ↓
AI / browser / RPC
```

Incorrect:

```text
User's Chrome tab
    ↓
local script
```

The laptop can be completely powered off.

---

# 34. Security Requirements

- Secrets stored as environment variables.
- Admin dashboard must be authenticated.
- No private keys needed for MVP.
- No wallet signing.
- No token approvals.
- No project-site downloads.
- No arbitrary command execution.
- Browser sandboxing enabled where possible.
- Sanitize URLs before browser navigation.
- Only allow HTTP/HTTPS.
- Restrict localhost/private-network access from browser jobs where possible to reduce SSRF risk.

---

# 35. Performance Requirements

Targets:

### Detection

New DexScreener profile:

```text
Target: < 30 seconds after appearing in source feed
```

### Initial classification

```text
Target: < 15 seconds
```

### Deep research

```text
Target: < 120 seconds
```

### Alert

```text
Target: < 10 seconds after final score
```

Ideal total:

```text
Detection → email:
30–150 seconds
```

---

# 36. Cost Control

The system should avoid wasting AI calls.

Cost controls:

1. Deduplicate first.
2. Apply simple metadata filters.
3. Run one visual classification.
4. Deep research only on passing candidates.
5. Cache website results.
6. Cache web-search results.
7. Limit token re-research frequency.
8. Use cheaper models for classification.
9. Use stronger models only for final synthesis if needed.
10. Store all outputs for reuse.

---

# 37. Historical Evaluation

Every alert should eventually be evaluated.

Example metrics:

```text
% alerts that gained 25%
% alerts that gained 50%
% alerts that gained 100%
median max return
median drawdown
time to peak
false-positive rate
utility classification accuracy
```

This is crucial.

The model should eventually be optimized based on:

```text
What actually performed?
```

rather than:

```text
What merely looked professional?
```

---

# 38. Reference Example Learning

Initial implementation:

Use a curated set of examples inside the classification prompt.

Later implementation:

1. Generate embeddings for:
   - icon
   - name
   - description
2. Store vector embeddings.
3. Retrieve closest historical examples.
4. Include them in classification context.

Example result:

```text
Candidate resembles:

72% Project A — 8.4x winner
69% Project B — 0.7x loser
31% Meme C
```

This should be treated as supporting evidence, not the final decision.

---

# 39. Risk Controls

The system must never assume:

- Professional logo = legitimate.
- Website = legitimate.
- X account = legitimate.
- GitHub = active development.
- High volume = healthy project.
- High buy count = safe token.
- Verified contract = safe token.
- Utility narrative = actual utility.

Research must combine several independent signals.

---

# 40. Research Evidence

Every important conclusion should point back to evidence.

Example:

```json
{
  "claim": "Project predates token launch",
  "evidence": [
    {
      "type": "WEB",
      "url": "https://...",
      "observedDate": "2026-03-19"
    },
    {
      "type": "SOCIAL",
      "url": "https://...",
      "observedDate": "2026-04-01"
    }
  ]
}
```

This will make debugging bad decisions much easier.

---

# 41. Development Phases

# Phase 1 — Discovery Engine

Build:

- Project setup
- PostgreSQL
- Prisma
- DexScreener adapter
- Robinhood filter
- Deduplication
- Logging
- Token storage

Acceptance criteria:

- Worker runs continuously.
- New RH profiles appear in DB.
- Duplicates are ignored.

---

# Phase 2 — Visual Classifier

Build:

- Image downloader
- AI provider abstraction
- Visual classification
- Zod validation
- Reference examples
- Classification thresholds

Acceptance criteria:

- Token gets utility/meme probability.
- Low-quality projects stop here.
- Passing projects are queued.

---

# Phase 3 — Market Research

Build:

- Dex market-data adapter
- Pair discovery
- Liquidity metrics
- Volume metrics
- Buy/sell metrics
- Market snapshots

Acceptance criteria:

- Every researched candidate has normalized market data.

---

# Phase 4 — Website Research

Build:

- Playwright worker
- Website extraction
- Linked pages
- Docs detection
- GitHub detection
- Website AI analysis

Acceptance criteria:

- Agent can summarize what a project claims to do.
- Broken sites fail gracefully.

---

# Phase 5 — Social / Search Research

Build:

- Search provider adapter
- X-link extraction
- Project history checks
- Indexed search
- Credibility analysis

Acceptance criteria:

- Agent can estimate whether project presence predates token launch.
- Missing social data does not crash research.

---

# Phase 6 — On-Chain Risk Engine

Build:

- Robinhood RPC connection
- Token contract inspection
- Ownership checks
- Supply checks
- Proxy checks
- Risk rules

Acceptance criteria:

- Contract analysis produces structured risk output.

---

# Phase 7 — Scoring Engine

Build:

- Factor normalization
- Weight configuration
- Hard reject rules
- Confidence score
- Final score

Acceptance criteria:

- Same research input always produces same weighted final score.

---

# Phase 8 — Email Alerts

Build:

- Resend
- HTML email
- Alert deduplication
- Retry queue

Acceptance criteria:

- Candidate over threshold generates one email.

---

# Phase 9 — Dashboard

Build:

- Feed
- Token detail
- Watchlist
- Alerts
- Reference examples
- Settings
- Health

Acceptance criteria:

- User can inspect what the agent has been doing without opening the DB.

---

# Phase 10 — Performance Tracking

Build:

- Scheduled market snapshots
- 15m/1h/6h/24h/48h performance
- Max gain / drawdown
- Historical analytics

Acceptance criteria:

- Every alert can later be compared against actual token performance.

---

# 42. MVP Acceptance Test

The MVP is complete when the following scenario works end-to-end.

### Given

A new token is added to the DexScreener profile feed on Robinhood Chain.

### When

The worker detects it.

### Then

1. A token DB record is created.
2. Duplicate detection passes.
3. Token image and metadata are analyzed.
4. If meme/low-quality, token is rejected.
5. If promising, a research job begins.
6. Market data is collected.
7. Website is visited.
8. Social/project history is researched.
9. Contract risk checks run.
10. Research is synthesized.
11. Final deterministic score is calculated.
12. If score is below threshold, no email is sent.
13. If score is above threshold and no hard rejection exists, email is sent.
14. All evidence and scores are stored.
15. Token begins post-detection performance tracking.

---

# 43. Example End-to-End State

```json
{
  "token": {
    "name": "Example Protocol",
    "symbol": "EXMP",
    "chain": "robinhood",
    "address": "0x..."
  },
  "classification": {
    "utilityProbability": 0.91,
    "memeProbability": 0.05,
    "brandingQuality": 0.83,
    "passed": true
  },
  "research": {
    "utilityScore": 92,
    "contractScore": 90,
    "credibilityScore": 82,
    "websiteScore": 88,
    "socialScore": 76,
    "liquidityScore": 78,
    "marketScore": 84,
    "holderScore": 71,
    "teamScore": 80,
    "brandingScore": 83,
    "finalScore": 84.8,
    "confidence": 79,
    "hardReject": false
  },
  "decision": "STRONG_WATCH"
}
```

No alert would be sent if alert threshold is `85`.

---

# 44. Suggested Build Order for Claude Code

Tell Claude Code to build the system incrementally.

Do **not** ask it to build the whole platform in one prompt.

Recommended tasks:

```text
Task 1
Initialize monorepo and infrastructure.

Task 2
Create Prisma schema and database layer.

Task 3
Build DexScreener provider adapter.

Task 4
Build continuous discovery worker.

Task 5
Build token deduplication.

Task 6
Build BullMQ infrastructure.

Task 7
Build AI provider abstraction.

Task 8
Build visual classifier.

Task 9
Build reference-example system.

Task 10
Build DexScreener market-data research.

Task 11
Build Playwright research service.

Task 12
Build web/search research.

Task 13
Build Robinhood Chain viem service.

Task 14
Build contract-risk checks.

Task 15
Build scoring engine.

Task 16
Build email alerts.

Task 17
Build watchlist refresh jobs.

Task 18
Build post-alert performance tracking.

Task 19
Build admin API.

Task 20
Build dashboard.

Task 21
Dockerize.

Task 22
Deploy to VPS.

Task 23
Add monitoring and error alerts.

Task 24
Run live shadow testing before trusting scores.
```

---

# 45. Claude Code Implementation Rules

When implementing:

1. Keep all external providers behind adapters.
2. Do not put provider-specific response shapes in business logic.
3. Validate external data.
4. Validate all AI output.
5. Never let AI directly trigger a transaction.
6. Store raw research evidence.
7. Make all thresholds configurable.
8. Add unit tests for scoring.
9. Add integration tests for discovery.
10. Use queue retries.
11. Use idempotent jobs.
12. Use structured logging.
13. Avoid giant service files.
14. Avoid giant AI prompts.
15. Version AI prompts.
16. Do not silently treat missing data as safe.
17. Do not silently swallow provider errors.
18. Use deterministic application logic for final decisions.

---

# 46. Testing Strategy

## Unit Tests

Test:

- Chain filtering
- Duplicate detection
- Score calculation
- Hard reject rules
- Confidence calculation
- Alert thresholds
- Data normalization

## Integration Tests

Test:

- DexScreener adapter
- Database
- Redis
- Email provider
- RPC provider
- AI structured output

## Browser Tests

Use fixture websites representing:

- Good utility project
- Meme project
- Broken website
- Parked domain
- Spam landing page

## End-to-End Test

Mock:

```text
Dex token → classification → research → scoring → email
```

---

# 47. Shadow Mode

Before relying on live alerts for capital allocation, run the system in **shadow mode**.

Shadow mode:

- Detect everything.
- Score everything.
- Send alerts if desired.
- Do not automate execution.
- Record subsequent performance.

Recommended evaluation period:

```text
At least 2–4 weeks
```

Then examine:

- Which factors correlate with winners?
- Which factors produce false positives?
- Are branding scores useful?
- Does social age matter?
- Does project history matter?
- Which liquidity ranges perform best?
- Does the 85 threshold make sense?

Use this data to recalibrate weights.

---

# 48. Important Product Decision

The system should not answer only:

```text
BUY
```

It should answer:

```text
HIGH CONVICTION CANDIDATE
Score: 89
Confidence: 76

Why:
...

Risks:
...
```

The user can still choose to treat that as an investment signal, but the software remains explainable and easier to audit.

---

# 49. Future Direct Chain Discovery

DexScreener should be the primary V1 source because it matches the user's observed workflow.

A future detector may monitor Robinhood Chain directly.

Potential future architecture:

```text
                 ┌─────────────────────────┐
                 │   Token Discovery     │
                 └─────────────┬──────────┘
                             │
        ┌──────────────────────┼───────────────────────┐
        │                    │                    │
 DexScreener Feed     New Pair Events      Social Discovery
        │                    │                    │
        └──────────────────────┼───────────────────────┘
                             ▼
                    Classification Engine
                             ▼
                      Research Engine
```

This may discover projects before they appear in the original DexScreener panel.

---

# 50. Definition of Done

The project is ready for production use when:

- [ ] Runs continuously on a remote server
- [ ] Polls token profiles automatically
- [ ] Filters Robinhood Chain
- [ ] Deduplicates tokens
- [ ] Performs visual utility classification
- [ ] Supports reference examples
- [ ] Rejects obvious memecoins before deep research
- [ ] Pulls market data
- [ ] Visits project websites
- [ ] Researches socials and web presence
- [ ] Performs on-chain checks
- [ ] Computes deterministic weighted score
- [ ] Applies hard rejection rules
- [ ] Computes confidence score
- [ ] Sends email alerts
- [ ] Stores research evidence
- [ ] Tracks watchlist
- [ ] Tracks post-alert performance
- [ ] Restarts automatically after crash/server reboot
- [ ] Has health monitoring
- [ ] Has structured logs
- [ ] Has tested retry handling
- [ ] Has no dependency on user's laptop

---

# 51. Final MVP User Experience

The ideal experience is:

The user does nothing.

The server runs continuously.

A new Robinhood Chain token appears.

Within roughly 1–2 minutes, the user receives:

```text
🚨 RH UTILITY CANDIDATE

Navier-Stokes — NAVIER
Score: 89/100
Confidence: 81/100

Utility: 94
Contract: 91
Credibility: 88
Website: 86
Social: 83
Liquidity: 78

Why it stands out:
• Existing technical product
• Project history predates token
• Strong documentation
• Organic social footprint
• No major contract red flags found

Risks:
• Low absolute liquidity
• Top holder concentration is moderately high
• Token is less than one hour old

Market Cap: $217K
Liquidity: $48K
5m Volume: $71K

[DexScreener]
[Website]
[X]
[Explorer]
```

The user opens the email, reviews the evidence, and decides whether to act.

That is the V1 product.

---

# 52. Core Product Philosophy

UtilityScout should optimize for:

```text
DISCOVER EARLY
      ↓
FILTER AGGRESSIVELY
      ↓
RESEARCH DEEPLY
      ↓
EXPLAIN EVERYTHING
      ↓
ALERT ONLY WHEN WORTH ATTENTION
      ↓
LEARN FROM REAL PERFORMANCE
```

The greatest long-term advantage will not come from the AI model alone.

It will come from building a private dataset containing:

```text
what was detected
+
what the agent thought
+
what the project looked like
+
what risks existed
+
what actually happened afterward
```

That historical dataset can gradually turn the agent from a generic crypto research bot into a system specifically optimized around the user's Robinhood Chain utility-token strategy.
