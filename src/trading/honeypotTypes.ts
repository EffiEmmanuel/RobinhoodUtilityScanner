// Shared between honeypotCheck.ts (EVM) and solanaHoneypotCheck.ts (Solana)
// — split out so the per-chain check modules never need to import each
// other (honeypotCheck.ts dispatches to solanaHoneypotCheck.ts, so the
// reverse import would be circular).

export interface HoneypotRiskResult {
  passed: boolean;
  reasons: string[];
  flags: string[];
}

// Same shape as poolDiscovery.ts's PoolDiscoveryInconclusiveError: a network
// or RPC-level failure here proves nothing about the token itself, but was
// previously folded into a hard "honeypot risk" reject with no retry. Callers
// should treat this the same way they treat pool-discovery-inconclusive —
// entryMonitor.ts's isTransientEntryInfraError already checks for it.
export class HoneypotCheckInconclusiveError extends Error {
  constructor(message: string) {
    super(`honeypot check inconclusive: ${message}`);
    this.name = "HoneypotCheckInconclusiveError";
  }
}

export function isHoneypotCheckInconclusiveError(err: unknown): boolean {
  return err instanceof HoneypotCheckInconclusiveError || String(err).includes("honeypot check inconclusive");
}
