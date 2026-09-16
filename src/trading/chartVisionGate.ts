import { chromium } from "playwright";
import { logger } from "../logger";
import { tradingConfig } from "./config";
import { callStructured, type ImageInput } from "../ai/provider";
import { ChartVisionVerdictSchema, CHART_VISION_VERDICT_JSON_SCHEMA, type ChartVisionVerdict } from "../ai/schemas";
import { CHART_VISION_GATE_SYSTEM, buildChartVisionPrompt } from "../ai/prompts";

/**
 * Gate on positionManager.ts's TRAILING_EXIT only (never RISK_EXIT/
 * INVALIDATION_EXIT — those return earlier in evaluateExits and this code
 * never runs for them). Reads an actual chart screenshot instead of trusting
 * a raw retrace % alone, so a normal pullback in an intact uptrend doesn't
 * get sold into reflexively. User directive 2026-09-16.
 *
 * Fails open on every error path (screenshot failure, vision-call failure,
 * low confidence, TREND_REVERSAL verdict) — the pre-existing TRAILING_EXIT
 * behavior always wins when this gate can't confidently say otherwise.
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

/** Playwright screenshot of DexScreener's public embeddable chart widget. */
export async function screenshotChart(pairUrl: string): Promise<ImageInput | undefined> {
  const embedUrl = `${pairUrl}${pairUrl.includes("?") ? "&" : "?"}embed=1&theme=dark&trades=0&info=0`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 800, height: 500 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    // domcontentloaded, not networkidle — see chartScreenshotTimeoutMs's doc
    // comment in config.ts.
    await page.goto(embedUrl, { timeout: tradingConfig.chartScreenshotTimeoutMs, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(tradingConfig.chartScreenshotSettleMs);
    const buf = await page.screenshot({ type: "png" });
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch (err) {
    logger.warn({ pairUrl, err: String(err) }, "chart screenshot failed — vision gate will fail open");
    return undefined;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function classifyChartVision(
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
 * it's directly unit-testable without mocking a screenshot/vision call.
 */
export function decideGateOutcome(verdict: ChartVisionVerdict | undefined, priorConsecutiveDefers: number): ChartVisionGateOutcome {
  if (!verdict) return { defer: false, reason: "no verdict available (screenshot or vision call failed) — falling through to trailing exit" };
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
  pairUrl: string;
  symbol?: string | null;
  retracePercent: number;
  peakMultiple: number;
}): Promise<ChartVisionGateOutcome> {
  const image = await screenshotChart(input.pairUrl);
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
