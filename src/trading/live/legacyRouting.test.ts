import { describe, it, expect, afterEach } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { assertDestinationAllowed } from "./wallet";
import { buildLegacyCalldata } from "./liveExecutionProvider";
import { isLegacyRoute, routeLabel, v3PathFor, type LegacyRoute } from "./routing";
import { ERC20_ALLOWANCE_ABI, ROBINHOOD_WETH, ROUTER_RECIPIENT, SWAP_ROUTER_02_ABI, UNISWAP_LEGACY_ADDRESSES, UNISWAP_V4_ADDRESSES } from "./contracts";

const TOKEN = "0x5d102d1e69e77591d486aa4f663b3645151bbdf6" as const;
const WALLET = "0x4f848bf992936f1e496d47cf0df3792aef732923" as const;
const approve = (spender: string) =>
  encodeFunctionData({ abi: ERC20_ALLOWANCE_ABI, functionName: "approve", args: [spender as `0x${string}`, 1_000n] });

describe("assertDestinationAllowed — token approvals", () => {
  const saved = process.env.ALLOWED_ROUTER_ADDRESSES;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_ROUTER_ADDRESSES;
    else process.env.ALLOWED_ROUTER_ADDRESSES = saved;
  });

  it("allows approving exactly the spender each purpose names", () => {
    delete process.env.ALLOWED_ROUTER_ADDRESSES;
    expect(() => assertDestinationAllowed("erc20-approve-permit2", TOKEN, approve(UNISWAP_V4_ADDRESSES.permit2))).not.toThrow();
    expect(() => assertDestinationAllowed("erc20-approve-swaprouter02", TOKEN, approve(UNISWAP_LEGACY_ADDRESSES.swapRouter02))).not.toThrow();
  });

  it("refuses any other spender, whatever the purpose", () => {
    delete process.env.ALLOWED_ROUTER_ADDRESSES;
    const attacker = "0x000000000000000000000000000000000000dEaD";
    expect(() => assertDestinationAllowed("erc20-approve-permit2", TOKEN, approve(attacker))).toThrow(/may only approve/);
    expect(() => assertDestinationAllowed("erc20-approve-swaprouter02", TOKEN, approve(UNISWAP_V4_ADDRESSES.permit2))).toThrow(/may only approve/);
  });

  it("refuses calldata that isn't a plain approve", () => {
    const transfer = encodeFunctionData({
      abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "transfer",
      args: [UNISWAP_V4_ADDRESSES.permit2 as `0x${string}`, 1n],
    });
    expect(() => assertDestinationAllowed("erc20-approve-permit2", TOKEN, transfer)).toThrow(/not a plain ERC20 approve/);
  });

  it("won't approve SwapRouter02 while it's off the router allowlist", () => {
    process.env.ALLOWED_ROUTER_ADDRESSES = UNISWAP_V4_ADDRESSES.universalRouter;
    expect(() => assertDestinationAllowed("erc20-approve-swaprouter02", TOKEN, approve(UNISWAP_LEGACY_ADDRESSES.swapRouter02))).toThrow(/not in the router allowlist/);
  });
});

describe("buildLegacyCalldata", () => {
  const v3: LegacyRoute = { venue: "v3", pool: "0xb6fe1035f6edfaeb7a9f7d4c19e11d35b3bd7c57", fee: 10_000 };
  const v2: LegacyRoute = { venue: "v2", pool: "0x02d356acd227e12a9573f0499f133c6e3b0af1c9" };

  const inner = (calldata: `0x${string}`) => {
    const outer = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: calldata });
    expect(outer.functionName).toBe("multicall");
    return (outer.args[1] as `0x${string}`[]).map((c) => decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: c }));
  };

  it("buys WETH -> token straight to the wallet on a v3 pool", () => {
    const calls = inner(buildLegacyCalldata(v3, TOKEN, true, 1_000n, 900n, WALLET));
    expect(calls).toHaveLength(1);
    expect(calls[0].functionName).toBe("exactInputSingle");
    const params = calls[0].args[0] as { tokenIn: string; tokenOut: string; fee: number; recipient: string; amountOutMinimum: bigint };
    expect(params.tokenIn).toBe(ROBINHOOD_WETH);
    expect(params.tokenOut.toLowerCase()).toBe(TOKEN);
    expect(params.fee).toBe(10_000);
    expect(params.recipient.toLowerCase()).toBe(WALLET);
    expect(params.amountOutMinimum).toBe(900n);
  });

  it("sells token -> WETH to the router, then unwraps to the wallet with the floor, on a v2 pool", () => {
    const calls = inner(buildLegacyCalldata(v2, TOKEN, false, 1_000n, 900n, WALLET));
    expect(calls.map((c) => c.functionName)).toEqual(["swapExactTokensForTokens", "unwrapWETH9"]);
    const [amountIn, amountOutMin, path, to] = calls[0].args as [bigint, bigint, string[], string];
    expect(amountIn).toBe(1_000n);
    expect(amountOutMin).toBe(900n);
    expect(path.map((a) => a.toLowerCase())).toEqual([TOKEN, ROBINHOOD_WETH.toLowerCase()]);
    expect(to).toBe(ROUTER_RECIPIENT.ADDRESS_THIS);
    const [minimum, recipient] = calls[1].args as [bigint, string];
    expect(minimum).toBe(900n);
    expect(recipient.toLowerCase()).toBe(WALLET);
  });
});

describe("v3 hub routes", () => {
  const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" as const;
  const route: LegacyRoute = {
    venue: "v3",
    pool: "0x1111111111111111111111111111111111111111",
    fee: 10_000,
    hub: { currency: META, pool: "0xa4bdb396a69617eb7f70e2cc1ef526f7340b1b0d", fee: 3000 },
  };
  const hex = (x: string) => x.toLowerCase().replace(/^0x/, "");
  const fee = (f: number) => f.toString(16).padStart(6, "0");

  it("packs WETH -> hub -> token for a buy and the exact reverse for a sell", () => {
    expect(v3PathFor(route, TOKEN, true)).toBe(`0x${hex(ROBINHOOD_WETH)}${fee(3000)}${hex(META)}${fee(10_000)}${hex(TOKEN)}`);
    expect(v3PathFor(route, TOKEN, false)).toBe(`0x${hex(TOKEN)}${fee(10_000)}${hex(META)}${fee(3000)}${hex(ROBINHOOD_WETH)}`);
  });

  it("buys through SwapRouter02 exactInput with that path, straight to the wallet", () => {
    const outer = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: buildLegacyCalldata(route, TOKEN, true, 1_000n, 900n, WALLET) });
    const [call] = (outer.args[1] as `0x${string}`[]).map((c) => decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: c }));
    expect(call.functionName).toBe("exactInput");
    const params = call.args[0] as { path: string; recipient: string; amountIn: bigint; amountOutMinimum: bigint };
    expect(params.path).toBe(v3PathFor(route, TOKEN, true));
    expect(params.recipient.toLowerCase()).toBe(WALLET);
    expect(params.amountOutMinimum).toBe(900n);
  });
});

describe("legacy route helpers", () => {
  it("tells v2/v3 routes apart from v4 routes and labels them", () => {
    const v3: LegacyRoute = { venue: "v3", pool: "0xb6fe1035f6edfaeb7a9f7d4c19e11d35b3bd7c57", fee: 3000 };
    expect(isLegacyRoute(v3)).toBe(true);
    expect(isLegacyRoute({ pools: [], hubs: [] })).toBe(false);
    expect(routeLabel(v3)).toBe("ETH(wrap)→WETH→token [v3 0.3%]");
  });
});
