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
  priceNative?: number; // price denominated in the quote token (ETH on Robinhood Chain) — used to convert USD position sizes into wei for live execution
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
