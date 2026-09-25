import { exitCategory } from "./calibrate";
import type { CostModel } from "./costs";
import type { RunRow } from "./run";
import { type PortfolioOptions, type PortfolioResult, type TradeStats, simulatePortfolio, tradeStats } from "./stats";

export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map((c) => String(c)))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(cells[0]), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...cells.slice(1).map(line)].join("\n");
}

export const pct = (x: number, digits = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%` : "n/a");
export const usd = (x: number, digits = 2) => (Number.isFinite(x) ? `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(digits)}` : "n/a");
export const num = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : x === Infinity ? "inf" : "n/a");

export interface ChainReport {
  chain: string;
  stats: TradeStats;
  portfolio: PortfolioResult;
  skipped: Record<string, number>;
  exits: Record<string, number>;
}

/** Per-chain stats at the reference size, plus a %-sized wallet replay. */
export function chainReports(rows: RunRow[], portfolio: Omit<PortfolioOptions, "costs">, costs: CostModel): ChainReport[] {
  const chains = [...new Set(rows.map((r) => r.chain))].sort();
  return chains.map((chain) => {
    const mine = rows.filter((r) => r.chain === chain);
    const traded = mine.filter((r) => r.sim && r.valued);
    const skipped: Record<string, number> = {};
    for (const r of mine) if (r.skip) skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
    const exits: Record<string, number> = {};
    for (const r of traded) {
      const k = exitCategory(r.sim!.exitReason);
      exits[k] = (exits[k] ?? 0) + 1;
    }
    return {
      chain,
      stats: tradeStats(traded.map((r) => r.valued!)),
      portfolio: simulatePortfolio(
        traded.map((r) => ({ chain, sim: r.sim! })),
        { ...portfolio, costs }
      ),
      skipped,
      exits,
    };
  });
}

export function formatChainReports(title: string, reports: ChainReport[], refSizeUsd: number): string {
  const out: string[] = [`### ${title}`, ""];
  out.push(
    table(
      ["chain", "n", "win rate", "avg win", "avg loss", "expectancy (net)", "90% CI", "median", "profit factor", "gross (pre-gas)"],
      reports.map((r) => [
        r.chain,
        r.stats.n,
        pct(r.stats.winRate * 100, 0),
        pct(r.stats.avgWinPct),
        pct(r.stats.avgLossPct),
        pct(r.stats.expectancyPct),
        `${pct(r.stats.expectancyCI90[0])} .. ${pct(r.stats.expectancyCI90[1])}`,
        pct(r.stats.medianPct),
        num(r.stats.profitFactor),
        pct(r.stats.grossExpectancyPct),
      ])
    )
  );
  out.push("", `Per-trade figures are at a ${usd(refSizeUsd)} position, net of modeled slippage, impact and gas.`, "");
  out.push(
    table(
      ["chain", "wallet", "end", "return", "max drawdown", "taken", "skipped (cash)", "skipped (concurrency)", "gas paid"],
      reports.map((r) => [
        r.chain,
        usd(r.portfolio.startEquityUsd),
        usd(r.portfolio.finalEquityUsd),
        pct(r.portfolio.returnPct),
        pct(-r.portfolio.maxDrawdownPct),
        r.portfolio.taken,
        r.portfolio.skippedNoCash,
        r.portfolio.skippedConcurrency,
        usd(r.portfolio.gasUsd),
      ])
    )
  );
  for (const r of reports) {
    const exits = Object.entries(r.exits)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const skipped = Object.entries(r.skipped)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    out.push("", `${r.chain} exits: ${exits || "none"}${skipped ? `; not simulated: ${skipped}` : ""}`);
  }
  return out.join("\n");
}

/** Downsampled equity curve for a report: at most `points` rows. */
export function curveSample(p: PortfolioResult, points = 12): { date: string; equityUsd: number }[] {
  const c = p.curve;
  if (c.length === 0) return [];
  const step = Math.max(1, Math.floor(c.length / points));
  const picked = c.filter((_, i) => i % step === 0);
  if (picked[picked.length - 1] !== c[c.length - 1]) picked.push(c[c.length - 1]);
  return picked.map((x) => ({ date: new Date(x.ts * 1000).toISOString().slice(0, 16).replace("T", " "), equityUsd: x.equityUsd }));
}
