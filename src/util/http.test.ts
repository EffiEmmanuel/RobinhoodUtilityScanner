import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJsonWithRetry } from "./http";

describe("fetchJsonWithRetry priority lane", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    process.env.JUPITER_MIN_REQUEST_INTERVAL_MS = "60";
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(new URL(url).searchParams.get("id")!);
      return new Response("{}", { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.JUPITER_MIN_REQUEST_INTERVAL_MS;
  });

  const url = (id: string) => `https://prio-test.jup.ag/quote?id=${id}`;

  it("never gives a low-priority request a slot while a live one is waiting", async () => {
    const first = fetchJsonWithRetry(url("live-1"), undefined, { retries: 1 });
    const paper = fetchJsonWithRetry(url("paper"), undefined, { retries: 1, priority: "low" });
    // Queued behind the paper request, but it must still go first.
    const second = fetchJsonWithRetry(url("live-2"), undefined, { retries: 1 });
    const third = fetchJsonWithRetry(url("live-3"), undefined, { retries: 1 });
    await Promise.all([first, paper, second, third]);
    expect(calls).toEqual(["live-1", "live-2", "live-3", "paper"]);
  });

  it("lets a low-priority request through when nothing live is waiting", async () => {
    await fetchJsonWithRetry(url("paper-alone"), undefined, { retries: 1, priority: "low" });
    expect(calls).toEqual(["paper-alone"]);
  });
});
