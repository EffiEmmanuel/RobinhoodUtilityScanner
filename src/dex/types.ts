// Normalized shapes used throughout the app. Raw DexScreener response shapes
// are converted into these at the edge (see client.ts) so a provider change
// only requires touching this module.

export interface DiscoveredTokenProfile {
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links: { type?: string; label?: string; url: string }[];
}

export interface MarketPair {
  dexId: string;
  pairAddress: string;
  url: string;
  priceUsd?: number;
  // Price denominated in the quote token — NOT reliably ETH. A pair's quote
  // token can be any other token that's ever been paired against this one
  // (a tokenized stock, a stablecoin, ...); only trust this as an ETH price
  // when quoteTokenAddress below is actually the native-ETH address. Confirmed
  // live 2026-09-11: OPAI's deepest DexScreener pair was quoted in QQQ, and
  // treating priceUsd/priceNative as ETH/USD there sized a live buy ~3.6x over
  // — see dex/client.ts's isNativeEthQuoted.
  priceNative?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  liquidityUsd?: number;
  volume5m?: number;
  volume1h?: number;
  volume6h?: number;
  volume24h?: number;
  buys5m?: number;
  sells5m?: number;
  buys1h?: number;
  sells1h?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  pairCreatedAt?: Date;
  baseTokenName?: string;
  baseTokenSymbol?: string;
  quoteSymbol?: string;
  // The quote token's contract address, checksummed as DexScreener returns
  // it. See isNativeEthQuoted in dex/client.ts — this is what actually tells
  // an ETH pair apart from one quoted in some other token that only happens
  // to share ETH's liquidity depth.
  quoteTokenAddress?: string;
  // DexScreener renders these on a token's page for virtually any pair,
  // independent of whether the project ever submitted the separate, narrower
  // token-profiles "update token info" product (see DiscoveredTokenProfile
  // above) — a real fallback source, not a duplicate of it.
  imageUrl?: string;
  headerUrl?: string;
  websites: string[];
  socials: { type: string; url: string }[];
}

export interface MarketSummary {
  pairs: MarketPair[];
  primaryPair?: MarketPair; // highest-liquidity pair
}
