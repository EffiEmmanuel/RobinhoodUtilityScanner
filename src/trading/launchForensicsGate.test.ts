import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const snapshots = new Map<string, { candidateId: string; status: string; features?: unknown; error?: string; rpcCalls?: number }>();
let candidates: { id: string; token: { address: string } }[] = [];
vi.mock("../db", () => ({
  db: {
    tradeCandidate: { findMany: vi.fn(async () => candidates) },
    launchForensicsSnapshot: {
      findMany: vi.fn(async ({ where }: { where: { candidateId: { in: string[] } } }) => [...snapshots.values()].filter((s) => where.candidateId.in.includes(s.candidateId))),
      findUnique: vi.fn(async ({ where }: { where: { candidateId: string } }) => snapshots.get(where.candidateId) ?? null),
      create: vi.fn(async ({ data }: { data: { candidateId: string; status: string } }) => {
        snapshots.set(data.candidateId, data);
        return data;
      }),
    },
  },
}));

import {
  computeNextLaunchForensics,
  forensicsSolanaRpc,
  launchForensicsSettings,
  launchForensicsVerdict,
  RpcBudget,
  withBudget,
  ForensicsBudgetExhausted,
} from "./launchForensicsGate";
import type { LaunchForensics } from "./launchForensics";
import type { SolanaRpc } from "./solanaLaunchForensics";

const settings = (over: Partial<typeof launchForensicsSettings> = {}) => ({
  ...launchForensicsSettings,
  enabled: true,
  minBudgetToStart: 10,
  timeoutMs: 1_000,
  thresholds: { maxFirst20BuyerSharePct: 0, maxLaunchSlotBuySharePct: 40, maxCreatorSoldPctOfPeak: 0, maxCreatorPriorDeadLaunches: 1, maxLinkedBuyerSharePct: 0 },
  ...over,
});

const bundled: LaunchForensics = {
  chain: "solana",
  token: "mint",
  asOf: "2026-09-25T00:00:00Z",
  launchpad: "pumpfun",
  unknowns: [],
  early: { creatorInitialBuyPct: 5, buyersSeen: 20, first10BuyerSharePct: 70, first20BuyerSharePct: 80, launchSlotBuyerCount: 4, launchSlotBuySharePct: 77, sameSlotBuyerCount: 4, sameSlotBuySharePct: 77 },
};

beforeEach(() => {
  snapshots.clear();
  candidates = [];
});

describe("RpcBudget", () => {
  it("stops at the daily cap and starts over the next UTC day", () => {
    let now = new Date("2026-09-25T23:59:00Z");
    const b = new RpcBudget(2, () => now);
    b.take();
    b.take();
    expect(b.remaining()).toBe(0);
    expect(() => b.take()).toThrow(ForensicsBudgetExhausted);
    now = new Date("2026-09-26T00:00:01Z");
    expect(b.remaining()).toBe(2);
  });

  it("never sends a call once the budget is spent", async () => {
    const inner = { call: vi.fn(async () => 1) } as unknown as SolanaRpc;
    const rpc = withBudget(inner, new RpcBudget(1));
    await rpc.call("getSlot", []);
    await expect(rpc.call("getSlot", [])).rejects.toThrow(ForensicsBudgetExhausted);
    expect(inner.call).toHaveBeenCalledTimes(1);
    expect(rpc.calls()).toBe(1);
  });
});

describe("forensicsSolanaRpc", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends calls the primary won't serve to the fallback", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).includes("primary")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Indexed requests require a personal token" } }), { status: 403 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }));
    }) as typeof fetch;
    const rpc = forensicsSolanaRpc({ rpcUrl: "https://primary.example", rpcFallbackUrl: "https://fallback.example", rps: 1000 });
    await expect(rpc.call("getTokenAccountsByOwner", [])).resolves.toEqual({ value: [] });
    expect(seen).toEqual(["https://primary.example", "https://fallback.example"]);
  });

  it("waits out rate limits with growing gaps, then gives up", async () => {
    const sentAt: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      sentAt.push(Date.now());
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;
    vi.useFakeTimers();
    const rpc = forensicsSolanaRpc({ rpcUrl: "https://primary.example", rpcFallbackUrl: "https://fallback.example", rps: 1000 });
    const p = rpc.call("getSlot", []);
    const assertion = expect(p).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    expect(sentAt).toHaveLength(5);
    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]);
    expect(gaps.map((g) => Math.round(g / 1000))).toEqual([2, 4, 8, 16]);
  });

  it("honours the server's Retry-After", async () => {
    const sentAt: number[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      sentAt.push(Date.now());
      return n++ === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }));
    }) as typeof fetch;
    vi.useFakeTimers();
    const rpc = forensicsSolanaRpc({ rpcUrl: "https://primary.example", rpcFallbackUrl: "https://fallback.example", rps: 1000 });
    const p = rpc.call("getSlot", []);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(7);
    vi.useRealTimers();
    expect(Math.round((sentAt[1] - sentAt[0]) / 1000)).toBe(30);
  });

  it("paces calls to the configured rate", async () => {
    const sentAt: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      sentAt.push(Date.now());
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
    }) as typeof fetch;
    vi.useFakeTimers();
    const rpc = forensicsSolanaRpc({ rpcUrl: "https://primary.example", rpcFallbackUrl: "https://fallback.example", rps: 2 });
    const all = Promise.all([rpc.call("a", []), rpc.call("b", []), rpc.call("c", [])]);
    await vi.runAllTimersAsync();
    await all;
    vi.useRealTimers();
    expect(sentAt[2] - sentAt[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe("computeNextLaunchForensics", () => {
  const rpc: SolanaRpc = { call: async () => null as never };

  it("stores the newest candidate's forensics and skips ones already read", async () => {
    candidates = [
      { id: "new", token: { address: "mintNew" } },
      { id: "old", token: { address: "mintOld" } },
    ];
    snapshots.set("new", { candidateId: "new", status: "READY" });
    const read = vi.fn(async () => bundled);
    expect(await computeNextLaunchForensics({ settings: settings(), budget: new RpcBudget(1000), rpc, read })).toBe("ready");
    expect(read).toHaveBeenCalledWith("mintOld", undefined, expect.anything(), expect.objectContaining({ includeFunding: false }));
    expect(snapshots.get("old")).toMatchObject({ status: "READY", features: expect.objectContaining({ launchpad: "pumpfun" }) });
  });

  it("records a read that can't succeed as UNAVAILABLE once", async () => {
    candidates = [{ id: "c1", token: { address: "m" } }];
    const read = vi.fn(async () => {
      throw new Error("getTokenSupply: -32602 Invalid param: not a Token mint");
    });
    const deps = { settings: settings(), budget: new RpcBudget(1000), rpc, read, retries: new Map() };
    expect(await computeNextLaunchForensics(deps)).toBe("unavailable");
    expect(snapshots.get("c1")).toMatchObject({ status: "UNAVAILABLE" });
    expect(await computeNextLaunchForensics(deps)).toBe("none");
  });

  it("retries a rate-limited read later, further apart each time, before giving up", async () => {
    candidates = [{ id: "c1", token: { address: "m" } }];
    const read = vi.fn(async () => {
      throw new Error("getTransaction: HTTP 429 Too many requests for a specific RPC call");
    });
    let now = 1_000_000;
    const deps = { settings: settings({ maxAttempts: 3, retryBaseSeconds: 60 }), budget: new RpcBudget(1000), rpc, read, retries: new Map(), now: () => now };
    expect(await computeNextLaunchForensics(deps)).toBe("deferred");
    expect(snapshots.size).toBe(0);
    // Not due yet: nothing else to read.
    now += 59_000;
    expect(await computeNextLaunchForensics(deps)).toBe("none");
    now += 1_000;
    expect(await computeNextLaunchForensics(deps)).toBe("deferred");
    now += 119_000;
    expect(await computeNextLaunchForensics(deps)).toBe("none");
    now += 1_000;
    expect(await computeNextLaunchForensics(deps)).toBe("unavailable");
    expect(snapshots.get("c1")?.error).toMatch(/^after 3 attempt\(s\): .*429/);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("stores a read that succeeds on retry", async () => {
    candidates = [{ id: "c1", token: { address: "m" } }];
    let calls = 0;
    const read = vi.fn(async () => {
      if (calls++ === 0) throw new Error("timed out after 120000ms");
      return bundled;
    });
    let now = 1_000_000;
    const retries = new Map();
    const deps = { settings: settings(), budget: new RpcBudget(1000), rpc, read, retries, now: () => now };
    expect(await computeNextLaunchForensics(deps)).toBe("deferred");
    now += 60_000;
    expect(await computeNextLaunchForensics(deps)).toBe("ready");
    expect(snapshots.get("c1")).toMatchObject({ status: "READY" });
    expect(retries.size).toBe(0);
  });

  it("doesn't start, and writes nothing, when the budget is nearly spent", async () => {
    candidates = [{ id: "c1", token: { address: "m" } }];
    const read = vi.fn(async () => bundled);
    expect(await computeNextLaunchForensics({ settings: settings({ minBudgetToStart: 50 }), budget: new RpcBudget(49), rpc, read })).toBe("budget");
    expect(read).not.toHaveBeenCalled();
    expect(snapshots.size).toBe(0);
  });
});

describe("launchForensicsVerdict", () => {
  it("passes when nothing has been read yet (UNKNOWN)", async () => {
    expect((await launchForensicsVerdict("missing", settings())).passed).toBe(true);
  });

  it("passes when the read failed", async () => {
    snapshots.set("c1", { candidateId: "c1", status: "UNAVAILABLE", error: "timeout" });
    expect((await launchForensicsVerdict("c1", settings())).passed).toBe(true);
  });

  it("holds an entry on stored positive evidence, under today's thresholds", async () => {
    snapshots.set("c1", { candidateId: "c1", status: "READY", features: bundled });
    const v = await launchForensicsVerdict("c1", settings());
    expect(v.passed).toBe(false);
    expect(v.failedChecks).toEqual(["forensics:launchBlockBundle"]);
    expect((await launchForensicsVerdict("c1", settings({ thresholds: { ...settings().thresholds, maxLaunchSlotBuySharePct: 0 } }))).passed).toBe(true);
  });

  it("doesn't touch the database while every threshold is off (report-only)", async () => {
    const { db } = await import("../db");
    const findUnique = vi.mocked(db.launchForensicsSnapshot.findUnique);
    findUnique.mockClear();
    snapshots.set("c1", { candidateId: "c1", status: "READY", features: bundled });
    const off = { maxFirst20BuyerSharePct: 0, maxLaunchSlotBuySharePct: 0, maxCreatorSoldPctOfPeak: 0, maxCreatorPriorDeadLaunches: 0, maxLinkedBuyerSharePct: 0 };
    expect((await launchForensicsVerdict("c1", settings({ thresholds: off }))).passed).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("passes when the lookup itself fails", async () => {
    const { db } = await import("../db");
    vi.mocked(db.launchForensicsSnapshot.findUnique).mockRejectedValueOnce(new Error("db down"));
    expect((await launchForensicsVerdict("c1", settings())).passed).toBe(true);
  });

  it("is on by default but gates nothing until a threshold is set", () => {
    expect(launchForensicsSettings.enabled).toBe(true);
    expect(Object.values(launchForensicsSettings.thresholds).every((t) => t === 0)).toBe(true);
  });

  it("is a no-op when forensics are disabled", async () => {
    snapshots.set("c1", { candidateId: "c1", status: "READY", features: bundled });
    expect((await launchForensicsVerdict("c1", settings({ enabled: false }))).passed).toBe(true);
  });
});
