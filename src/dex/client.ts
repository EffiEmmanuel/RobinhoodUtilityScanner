import { config } from "../config";
import { fetchJsonWithRetry } from "../util/http";
import { logger } from "../logger";
import type { DiscoveredTokenProfile, MarketPair, MarketSummary } from "./types";

// Raw DexScreener response shapes (provider-specific). Nothing outside this
// file should know about these — see FR-001/FR-002: wrap the provider so a
// response-shape change only touches this adapter.

interface RawTokenProfile {
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: { type?: string; label?: string; url: string }[];
}

interface RawPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  info?: {
    imageUrl?: string;
    header?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

function normalizeProfile(raw: RawTokenProfile): DiscoveredTokenProfile {
  return {
    chainId: raw.chainId,
    tokenAddress: raw.tokenAddress,
    icon: raw.icon,
    header: raw.header,
    description: raw.description,
    links: (raw.links ?? []).map((l) => ({ type: l.type, label: l.label, url: l.url })),
  };
}

function normalizePair(raw: RawPair): MarketPair {
  return {
    dexId: raw.dexId,
    pairAddress: raw.pairAddress,
    url: raw.url,
    priceUsd: raw.priceUsd ? Number(raw.priceUsd) : undefined,
    priceNative: raw.priceNative ? Number(raw.priceNative) : undefined,
    marketCapUsd: raw.marketCap,
    fdvUsd: raw.fdv,
    liquidityUsd: raw.liquidity?.usd,
    volume5m: raw.volume?.m5,
    volume1h: raw.volume?.h1,
    volume6h: raw.volume?.h6,
    volume24h: raw.volume?.h24,
    buys5m: raw.txns?.m5?.buys,
    sells5m: raw.txns?.m5?.sells,
    buys1h: raw.txns?.h1?.buys,
    sells1h: raw.txns?.h1?.sells,
    priceChange5m: raw.priceChange?.m5,
    priceChange1h: raw.priceChange?.h1,
    pairCreatedAt: raw.pairCreatedAt ? new Date(raw.pairCreatedAt) : undefined,
    baseTokenName: raw.baseToken?.name,
    baseTokenSymbol: raw.baseToken?.symbol,
    quoteSymbol: raw.quoteToken?.symbol,
    websites: (raw.info?.websites ?? []).map((w) => w.url),
    socials: (raw.info?.socials ?? []).map((s) => ({ type: s.type, url: s.url })),
  };
}

export async function fetchLatestTokenProfiles(): Promise<DiscoveredTokenProfile[]> {
  const url = `${config.dexscreenerBaseUrl}/token-profiles/latest/v1`;
  const raw = await fetchJsonWithRetry<RawTokenProfile[]>(url);
  if (!Array.isArray(raw)) {
    logger.warn({ url }, "unexpected token-profiles response shape");
    return [];
  }
  return raw.map(normalizeProfile);
}

export async function fetchMarketForToken(
  chainId: string,
  tokenAddress: string
): Promise<MarketSummary> {
  const url = `${config.dexscreenerBaseUrl}/token-pairs/v1/${chainId}/${tokenAddress}`;
  const raw = await fetchJsonWithRetry<RawPair[]>(url);
  const pairs = (Array.isArray(raw) ? raw : []).map(normalizePair);
  const primaryPair = pairs.slice().sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  return { pairs, primaryPair };
}
