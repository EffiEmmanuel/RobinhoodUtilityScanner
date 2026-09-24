import { db } from "../db";
import { logger } from "../logger";
import { LedgerEntryType } from "../generated/prisma";
import { recordLedgerEntry } from "./portfolio";
import type { FillResult } from "./executionFacade";

/**
 * A live EVM buy pre-approves its future sell in the background (see
 * executeBuyFill) so the approval never sits on the buy's critical path. Its
 * gas is still this position's cost: once it confirms, fold it into the BUY
 * execution's gasCostUsd, where pnl.ts picks it up. Fire-and-forget, same as
 * the approval itself — a failure here only loses a few cents of accounting,
 * never blocks a trade.
 */
export function attachPendingApprovalGas(fill: FillResult, tradeId: string, buyExecutionId: string): void {
  if (!fill.pendingApprovalGasUsd) return;
  void fill.pendingApprovalGasUsd
    .then(async (gasUsd) => {
      if (gasUsd <= 0) return;
      await db.tradeExecution.update({ where: { id: buyExecutionId }, data: { gasCostUsd: { increment: gasUsd } } });
      await recordLedgerEntry({ type: LedgerEntryType.GAS, tradeId, amountUsd: -gasUsd, notes: "real gas (pre-approval for this position's sell)" });
    })
    .catch((err) => logger.warn({ tradeId, err: String(err) }, "could not record the pre-approval's gas on this trade"));
}
