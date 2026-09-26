import { describe, it, expect, vi } from "vitest";
import dns from "node:dns";
import net from "node:net";

describe("netDefaults", () => {
  it("is applied by importing db, so scripts that never run index.ts get it", async () => {
    const order = vi.spyOn(dns, "setDefaultResultOrder");
    const race = vi.spyOn(net, "setDefaultAutoSelectFamily");
    // Constructing the client opens no connection; any URL will do.
    vi.stubEnv("DATABASE_URL", process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/test");
    vi.resetModules();
    await import("./db");
    vi.unstubAllEnvs();
    expect(order).toHaveBeenCalledWith("ipv4first");
    expect(race).toHaveBeenCalledWith(false);
    expect(dns.getDefaultResultOrder()).toBe("ipv4first");
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
  });
});
