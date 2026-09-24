import { describe, it, expect } from "vitest";
import { resendCooldownMs, resendKeyOrder } from "./mailer";

describe("resendCooldownMs", () => {
  it("benches a key for an hour when it hits a quota", () => {
    expect(resendCooldownMs(429, "daily_quota_exceeded")).toBe(60 * 60_000);
    expect(resendCooldownMs(429, "monthly_quota_exceeded")).toBe(60 * 60_000);
  });

  it("benches a key for hours when it can't deliver at all", () => {
    expect(resendCooldownMs(403, "validation_error")).toBe(6 * 60 * 60_000);
    expect(resendCooldownMs(401, "missing_api_key")).toBe(6 * 60 * 60_000);
  });

  it("never benches a key for a per-second rate limit or a server error", () => {
    expect(resendCooldownMs(429, "rate_limit_exceeded")).toBe(0);
    expect(resendCooldownMs(500, "internal_server_error")).toBe(0);
    expect(resendCooldownMs(422, "invalid_parameter")).toBe(0);
  });
});

describe("resendKeyOrder", () => {
  const keys = ["primary", "second", "legacy"];
  const now = 1_000_000;

  it("keeps priority order when no key is benched", () => {
    expect(resendKeyOrder(keys, new Map(), now)).toEqual(keys);
  });

  it("skips benched keys until their cooldown ends", () => {
    const cooldowns = new Map([["primary", now + 1]]);
    expect(resendKeyOrder(keys, cooldowns, now)).toEqual(["second", "legacy"]);
    expect(resendKeyOrder(keys, cooldowns, now + 1)).toEqual(keys);
  });

  it("tries every key when all of them are benched rather than dropping the email", () => {
    const cooldowns = new Map(keys.map((key) => [key, now + 60_000]));
    expect(resendKeyOrder(keys, cooldowns, now)).toEqual(keys);
  });
});
