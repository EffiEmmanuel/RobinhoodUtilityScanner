import { describe, it, expect } from "vitest";
import { parseSizeBrackets, loadSizeBrackets, sizeBracketFor, DEFAULT_AUTONOMOUS_SIZE_BRACKETS } from "./sizeBrackets";

describe("parseSizeBrackets", () => {
  it("reads the default table", () => {
    expect(parseSizeBrackets(DEFAULT_AUTONOMOUS_SIZE_BRACKETS)).toEqual([
      { fromUsd: 0, percent: 40 },
      { fromUsd: 50, percent: 30 },
      { fromUsd: 100, percent: 20 },
      { fromUsd: 250, percent: 15 },
      { fromUsd: 500, percent: 10 },
      { fromUsd: 1000, percent: 7.5 },
      { fromUsd: 2500, percent: 5 },
    ]);
  });

  it("tolerates spaces", () => {
    expect(parseSizeBrackets(" 0 : 25 , 100:10 ")).toEqual([
      { fromUsd: 0, percent: 25 },
      { fromUsd: 100, percent: 10 },
    ]);
  });

  it.each([
    ["", "no brackets"],
    ["50:30,100:20", "must start at 0"],
    ["0:40,100:20,50:30", "must rise"],
    ["0:40,50:40,50:30", "must rise"],
    ["0:0", "outside (0, 100]"],
    ["0:101", "outside (0, 100]"],
    ["0:40,50", "not lowerBoundUsd:percent"],
    ["0:40;50:30", "not lowerBoundUsd:percent"],
    ["0:-5", "not lowerBoundUsd:percent"],
    ["$0:40", "not lowerBoundUsd:percent"],
  ])("rejects %j", (raw, message) => {
    expect(() => parseSizeBrackets(raw)).toThrow(message);
  });
});

describe("loadSizeBrackets", () => {
  const defaults = parseSizeBrackets(DEFAULT_AUTONOMOUS_SIZE_BRACKETS);

  it("uses the default table when nothing is set", () => {
    expect(loadSizeBrackets("AUTONOMOUS_SIZE_BRACKETS", undefined)).toEqual(defaults);
    expect(loadSizeBrackets("AUTONOMOUS_SIZE_BRACKETS", "  ")).toEqual(defaults);
  });

  it("falls back to the default table on a malformed value", () => {
    expect(loadSizeBrackets("AUTONOMOUS_SIZE_BRACKETS_SOLANA", "0:40,50")).toEqual(defaults);
  });

  it("uses a valid value", () => {
    expect(loadSizeBrackets("AUTONOMOUS_SIZE_BRACKETS_SOLANA", "0:20")).toEqual([{ fromUsd: 0, percent: 20 }]);
  });
});

describe("sizeBracketFor", () => {
  const brackets = parseSizeBrackets(DEFAULT_AUTONOMOUS_SIZE_BRACKETS);

  it("steps at each lower bound, not before", () => {
    expect(sizeBracketFor(brackets, 49.99)).toEqual({ percent: 40, label: "$0–50" });
    expect(sizeBracketFor(brackets, 50)).toEqual({ percent: 30, label: "$50–100" });
    expect(sizeBracketFor(brackets, 999.99).percent).toBe(10);
    expect(sizeBracketFor(brackets, 1000)).toEqual({ percent: 7.5, label: "$1,000–2,500" });
  });

  it("keeps the last bracket open-ended", () => {
    expect(sizeBracketFor(brackets, 1_000_000)).toEqual({ percent: 5, label: "$2,500+" });
  });

  it("puts zero or negative equity in the first bracket", () => {
    expect(sizeBracketFor(brackets, 0).percent).toBe(40);
    expect(sizeBracketFor(brackets, -3).percent).toBe(40);
  });
});
