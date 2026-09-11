import { createWalletClient, createPublicClient, http, fallback, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../../config";
import { logger } from "../../logger";
import { getAllowedRouterAddresses, UNISWAP_V4_ADDRESSES } from "./contracts";

/**
 * §20 Wallet Security Requirements — this is the ONLY module in the codebase
 * allowed to read BOT_WALLET_PRIVATE_KEY. Never log it, never return it,
 * never pass it to an AI call, never expose it through an API response. Every
 * other module gets an address (safe to log) or a signing function — never
 * the key itself.
 */

const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rhRpcUrl] } },
} as const;

// Tries the primary RPC first on every request, only moving to the
// rate-limited fallback once the primary actually fails (viem's default
// fallback behavior, not a sticky switch) — see config.ts's rhRpcFallbackUrl
// for why this exists.
const rpcTransport = fallback([http(config.rhRpcUrl), http(config.rhRpcFallbackUrl)]);

let account: ReturnType<typeof privateKeyToAccount> | undefined;

function getAccount() {
  if (account) return account;
  const key = process.env.BOT_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — live execution cannot sign anything without it");
  account = privateKeyToAccount(key as Hex);
  return account;
}

export function isWalletConfigured(): boolean {
  return Boolean(process.env.BOT_WALLET_PRIVATE_KEY);
}

/** Safe to log/return anywhere — this is the whole reason this function exists. */
export function getWalletAddress(): `0x${string}` {
  return getAccount().address;
}

// Robinhood Chain produces a block roughly every 100ms (confirmed in
// poolDiscovery.ts), but viem's default pollingInterval (built for ~12s L1
// block times) waits up to 4s between each waitForTransactionReceipt check —
// on a buy/sell that's the dominant chunk of perceived execution latency,
// completely unrelated to how fast the chain itself confirms. Tightened to
// match the chain's real cadence so a receipt is picked up within one or two
// polls of it actually landing, not up to 4s later.
const FAST_CHAIN_POLLING_INTERVAL_MS = 250;

export function getPublicClient() {
  return createPublicClient({ chain: robinhoodChain, transport: rpcTransport, pollingInterval: FAST_CHAIN_POLLING_INTERVAL_MS });
}

// §31 nonce safety: this is a single process, but BUY and SELL can be
// triggered from independent loops (entry monitor vs position manager) that
// could otherwise race to send two transactions before either confirms,
// fetching the same nonce. Every send is serialized through this one queue —
// simple and sufficient for a single-process deployment; a real distributed
// nonce lock only matters once this runs across multiple processes.
let sendQueue: Promise<unknown> = Promise.resolve();

// §28 router allowlist, enforced at the ONE place that actually signs, as
// defense-in-depth against a bug anywhere upstream trying to send to an
// address that was never vetted. Approvals are only ever legitimately sent
// to the token itself (approving Permit2) or to the canonical Permit2
// address (approving the router) — never to an arbitrary spender.
type SignPurpose = "swap" | "erc20-approve-permit2" | "permit2-approve-router";

function assertDestinationAllowed(purpose: SignPurpose, to: `0x${string}`): void {
  const toLower = to.toLowerCase();
  if (purpose === "swap") {
    const allowed = getAllowedRouterAddresses();
    if (!allowed.includes(toLower)) {
      throw new Error(`refusing to sign: ${to} is not in the router allowlist (${allowed.join(", ")})`);
    }
  } else if (purpose === "permit2-approve-router") {
    if (toLower !== UNISWAP_V4_ADDRESSES.permit2.toLowerCase()) {
      throw new Error(`refusing to sign: permit2-approve-router must target Permit2 itself, got ${to}`);
    }
  }
  // "erc20-approve-permit2" targets the token contract itself, which is
  // legitimately dynamic (any token this app trades) — nothing to allowlist
  // by address; permit2Approvals.ts already hardcodes the spender as Permit2.
}

/**
 * The only function in the codebase that actually signs a transaction. Chain
 * ID is verified by viem against the account/transport automatically, but we
 * also check it explicitly here per §20 ("verify Robinhood Chain ID before
 * every signing operation") since silent cross-chain replay is exactly the
 * kind of mistake this rule exists to prevent.
 */
export function signAndSendTransaction(tx: { to: `0x${string}`; data: `0x${string}`; value: bigint; purpose: SignPurpose }): Promise<`0x${string}`> {
  assertDestinationAllowed(tx.purpose, tx.to);
  const task = sendQueue.then(async () => {
    const acct = getAccount();
    const client = createWalletClient({ account: acct, chain: robinhoodChain, transport: rpcTransport, pollingInterval: FAST_CHAIN_POLLING_INTERVAL_MS });
    const chainId = await client.getChainId();
    if (chainId !== robinhoodChain.id) {
      throw new Error(`refusing to sign: connected chainId ${chainId} does not match Robinhood Chain (${robinhoodChain.id})`);
    }
    logger.info({ to: tx.to, value: tx.value.toString(), from: acct.address, purpose: tx.purpose }, "signing and sending live transaction");
    return client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  });
  // Keep the queue alive even if this send fails — swallow here, the real
  // error still propagates to this call's own caller via `task`.
  sendQueue = task.catch(() => undefined);
  return task;
}

export { robinhoodChain };
