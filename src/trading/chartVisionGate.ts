import sharp from "sharp";
import { db } from "../db";
import { logger } from "../logger";
import { tradingConfig } from "./config";
import { callStructured, type ImageInput } from "../ai/provider";
import { ChartVisionVerdictSchema, CHART_VISION_VERDICT_JSON_SCHEMA, type ChartVisionVerdict } from "../ai/schemas";
import { CHART_VISION_GATE_SYSTEM, buildChartVisionPrompt } from "../ai/prompts";

/**
 * Gate on positionManager.ts's TRAILING_EXIT only (never RISK_EXIT/
 * INVALIDATION_EXIT — those return earlier in evaluateExits and this code
 * never runs for them). Reads an actual chart instead of trusting a raw
 * retrace % alone, so a normal pullback in an intact uptrend doesn't get
 * sold into reflexively. User directive 2026-09-16.
 *
 * The chart is rendered from this trade's own PositionSnapshot history
 * (written every tick by monitorOneTrade since the position opened) rather
 * than screenshotting DexScreener's page. Tried the screenshot approach
 * first; measured live 2026-09-16 at ~9-11s per screenshot (DexScreener's
 * embed widget is slow to paint real data, and sometimes still hadn't after
 * 9s), which — on top of being slow — meant the chart the gate read could
 * already be stale relative to the trigger by the time it mattered.
 * PositionSnapshot data needs no external fetch at all: it's already as
 * fresh as the trigger itself (same monitoring loop writes it), and
 * rendering our own image from it is a DB query + in-process draw, no
 * browser. GeckoTerminal's free OHLCV API was considered and ruled out —
 * confirmed live it doesn't index Robinhood Chain at all.
 *
 * Fails open on every error path (too little history, render failure,
 * vision-call failure, low confidence, TREND_REVERSAL verdict) — the
 * pre-existing TRAILING_EXIT behavior always wins when this gate can't
 * confidently say otherwise.
 */

// Per-trade count of consecutive ticks this gate has deferred an exit —
// in-memory by design, same pattern as positionManager.ts's exitBlockedSince:
// the only thing lost on a restart is the streak, which just starts fresh
// rather than getting stuck deferred, and chartVisionMaxConsecutiveDefers
// bounds it either way.
const consecutiveDefers = new Map<string, number>();

export function resetChartVisionDeferStreak(tradeId: string): void {
  consecutiveDefers.delete(tradeId);
}

export interface ChartPoint {
  capturedAt: Date;
  priceUsd: number;
  volume5m: number | null;
}

const CHART_WIDTH = 800;
const CHART_HEIGHT = 500;
const PRICE_PANEL_HEIGHT = 330;
const VOLUME_PANEL_TOP = 400;
const VOLUME_PANEL_HEIGHT = 90;
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 8;

// Exported for direct testing/verification of the render step without a
// PositionSnapshot DB round-trip — pure function, safe to expose.
export function buildChartSvg(points: ChartPoint[]): string {
  const plotWidth = CHART_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const prices = points.map((p) => p.priceUsd);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || maxPrice * 0.01 || 1;

  const volumes = points.map((p) => p.volume5m ?? 0);
  const maxVolume = Math.max(...volumes, 1);

  const x = (i: number) => MARGIN_LEFT + (points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
  const yPrice = (price: number) => 10 + PRICE_PANEL_HEIGHT * (1 - (price - minPrice) / priceRange);

  const pricePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yPrice(p.priceUsd).toFixed(1)}`).join(" ");

  const peakIdx = prices.indexOf(maxPrice);
  const peakMarker = `<circle cx="${x(peakIdx).toFixed(1)}" cy="${yPrice(maxPrice).toFixed(1)}" r="4" fill="#4ade80" />`;

  const barWidth = Math.max(1, plotWidth / points.length - 1);
  const volumeBars = points
    .map((p, i) => {
      const v = p.volume5m ?? 0;
      const h = (v / maxVolume) * VOLUME_PANEL_HEIGHT;
      return `<rect x="${(x(i) - barWidth / 2).toFixed(1)}" y="${(VOLUME_PANEL_TOP + VOLUME_PANEL_HEIGHT - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="#60a5fa" opacity="0.7" />`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${CHART_HEIGHT}">
  <rect width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#0f1117" />
  <text x="${MARGIN_LEFT}" y="20" fill="#9ca3af" font-family="monospace" font-size="13">price (high $${maxPrice.toPrecision(4)} / low $${minPrice.toPrecision(4)})</text>
  <path d="${pricePath}" fill="none" stroke="#e5e7eb" stroke-width="2" />
  ${peakMarker}
  <text x="${MARGIN_LEFT}" y="${VOLUME_PANEL_TOP - 6}" fill="#9ca3af" font-family="monospace" font-size="12">volume (5m)</text>
  ${volumeBars}
  <text x="${MARGIN_LEFT}" y="${CHART_HEIGHT - 8}" fill="#6b7280" font-family="monospace" font-size="11">${points.length} snapshots, ${points[0].capturedAt.toISOString()} to ${points[points.length - 1].capturedAt.toISOString()}</text>
</svg>`;
}

/**
 * Renders this trade's own price/volume history since it opened — no
 * external fetch, just this trade's PositionSnapshot rows (already written
 * every monitoring tick) plus an in-process SVG->PNG raster. Returns
 * undefined (fail open) when there isn't enough history yet to plot
 * anything meaningful.
 */
export async function renderPositionChart(tradeId: string): Promise<ImageInput | undefined> {
  try {
    const snapshots = await db.positionSnapshot.findMany({
      where: { tradeId, priceUsd: { not: null } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, priceUsd: true, volume5m: true },
    });
    if (snapshots.length < tradingConfig.chartRenderMinSnapshots) {
      logger.info({ tradeId, snapshotCount: snapshots.length }, "too little PositionSnapshot history to render a chart yet — vision gate will fail open");
      return undefined;
    }
    const points: ChartPoint[] = snapshots.map((s) => ({ capturedAt: s.capturedAt, priceUsd: s.priceUsd as number, volume5m: s.volume5m }));
    const svg = buildChartSvg(points);
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch (err) {
    logger.warn({ tradeId, err: String(err) }, "chart render failed — vision gate will fail open");
    return undefined;
  }
}

// Exported for direct testing/verification of the vision-call step in
// isolation (e.g. against a synthetic chart, no DB involved).
export async function classifyChartVision(
  image: ImageInput,
  context: { symbol?: string | null; retracePercent: number; peakMultiple: number }
): Promise<ChartVisionVerdict | undefined> {
  try {
    return await callStructured({
      model: tradingConfig.chartVisionModel,
      system: CHART_VISION_GATE_SYSTEM,
      prompt: buildChartVisionPrompt(context),
      schema: ChartVisionVerdictSchema,
      jsonSchema: CHART_VISION_VERDICT_JSON_SCHEMA,
      toolName: "submit_chart_vision_verdict",
      images: [image],
      maxTokens: 800,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "chart vision classification failed — vision gate will fail open");
    return undefined;
  }
}

export interface ChartVisionGateOutcome {
  defer: boolean;
  verdict?: ChartVisionVerdict;
  reason: string;
}

/**
 * Pure decision, given an (optional) verdict and how many consecutive ticks
 * this trade has already been deferred. Kept separate from the IO above so
 * it's directly unit-testable without mocking a render/vision call.
 */
export function decideGateOutcome(verdict: ChartVisionVerdict | undefined, priorConsecutiveDefers: number): ChartVisionGateOutcome {
  if (!verdict) return { defer: false, reason: "no verdict available (too little history, render failure, or vision call failed) — falling through to trailing exit" };
  if (priorConsecutiveDefers >= tradingConfig.chartVisionMaxConsecutiveDefers) {
    return { defer: false, verdict, reason: `already deferred ${priorConsecutiveDefers} consecutive ticks (max ${tradingConfig.chartVisionMaxConsecutiveDefers}) — trailing exit proceeds` };
  }
  if (verdict.verdict !== "RETRACEMENT_IN_UPTREND") {
    return { defer: false, verdict, reason: `verdict=${verdict.verdict} — trailing exit proceeds` };
  }
  if (verdict.confidence < tradingConfig.chartVisionMinConfidenceToDefer) {
    return { defer: false, verdict, reason: `confidence ${verdict.confidence.toFixed(2)} below threshold ${tradingConfig.chartVisionMinConfidenceToDefer} — trailing exit proceeds` };
  }
  return { defer: true, verdict, reason: verdict.reasoning };
}

/** Full IO + decision. Only ever called for a non-emergency TRAILING_EXIT decision. */
export async function evaluateChartVisionGate(input: {
  tradeId: string;
  symbol?: string | null;
  retracePercent: number;
  peakMultiple: number;
}): Promise<ChartVisionGateOutcome> {
  const image = await renderPositionChart(input.tradeId);
  const verdict = image
    ? await classifyChartVision(image, { symbol: input.symbol, retracePercent: input.retracePercent, peakMultiple: input.peakMultiple })
    : undefined;

  const priorConsecutiveDefers = consecutiveDefers.get(input.tradeId) ?? 0;
  const outcome = decideGateOutcome(verdict, priorConsecutiveDefers);

  if (outcome.defer) {
    consecutiveDefers.set(input.tradeId, priorConsecutiveDefers + 1);
  } else {
    resetChartVisionDeferStreak(input.tradeId);
  }
  return outcome;
}
