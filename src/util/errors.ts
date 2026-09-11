/**
 * Confirmed live: an RPC provider's Cloudflare bot-challenge page (a full
 * HTML document, several KB, sometimes including a long unbroken
 * base64-encoded SVG) came back as the error body for a failed RPC call —
 * viem folds that entire body into err.message. Logging that verbatim in a
 * hot retry loop (onchainDiscoveryLoop polls every few seconds) floods
 * stdout with multi-KB lines on every failure; rendering it verbatim in the
 * dashboard broke the circuit-breaker banner's layout (see portfolio.ts's
 * original summarizeError, now consolidated here). One line, capped length,
 * never the raw upstream response body.
 */
export function summarizeError(err: unknown, maxLen = 160): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "…" : oneLine;
}
