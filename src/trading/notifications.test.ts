import { describe, it, expect, vi } from "vitest";

const sendMail = vi.fn().mockResolvedValue(undefined);
vi.mock("../notify/mailer", () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));
vi.mock("../db", () => ({ db: {} }));
vi.mock("../config", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config")>();
  return { config: { ...original.config, alertEmailFrom: "bot@example.com", alertEmailTo: "owner@example.com" } };
});

import { sendLanePauseEmail } from "./notifications";

describe("sendLanePauseEmail", () => {
  it("says the lane won't resume on its own, how to resume it, and that exits carry on", async () => {
    await sendLanePauseEmail({ reasons: ["solana MOMENTUM_TACTICAL: the last 20 autonomous trades lost money"] });
    const { subject, text } = sendMail.mock.calls[0][0] as { subject: string; text: string };
    expect(subject).toContain("Autonomous entries PAUSED");
    expect(text).toContain("- solana MOMENTUM_TACTICAL: the last 20 autonomous trades lost money");
    expect(text).toContain(
      "Stays paused until a new strategy version is promoted, or EXPECTANCY_PAUSE_ENABLED=false is set on Railway. Open positions still exit normally."
    );
  });
});
