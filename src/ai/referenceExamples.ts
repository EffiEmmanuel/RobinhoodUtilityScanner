import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "../logger";

const ReferenceExampleSchema = z.object({
  category: z.enum(["WINNER_UTILITY", "LOSER_UTILITY", "MEME", "SCAM", "AMBIGUOUS"]),
  name: z.string().optional(),
  symbol: z.string().optional(),
  contract: z.string().optional(),
  notes: z.string().optional(),
  peakMultiple: z.number().optional(),
  entryMcap: z.number().optional(),
  liquidityAtEntry: z.number().optional(),
});
export type ReferenceExample = z.infer<typeof ReferenceExampleSchema>;

const FILE_PATH = join(process.cwd(), "examples", "reference-examples.json");

let cache: ReferenceExample[] | undefined;

/**
 * V1 reference-example store (FR-006): a curated JSON file the user edits by
 * hand, loaded once and included as few-shot context in classification
 * prompts. A future version can swap this for embeddings + similarity search
 * without changing callers.
 */
export function loadReferenceExamples(): ReferenceExample[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(FILE_PATH, "utf-8"));
    cache = z.array(ReferenceExampleSchema).parse(raw);
  } catch (err) {
    logger.warn({ err: String(err), FILE_PATH }, "could not load reference examples, continuing without them");
    cache = [];
  }
  return cache;
}

export function formatReferenceExamplesForPrompt(examples: ReferenceExample[]): string {
  if (examples.length === 0) return "No reference examples available.";
  return examples
    .map((e) => {
      const stats = [
        e.peakMultiple ? `peak ${e.peakMultiple}x` : undefined,
        e.entryMcap ? `mcap ~$${Math.round(e.entryMcap).toLocaleString()}` : undefined,
        e.liquidityAtEntry ? `liquidity ~$${Math.round(e.liquidityAtEntry).toLocaleString()}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return `- [${e.category}] ${e.name ?? "(unnamed)"}${stats ? ` (${stats})` : ""}: ${e.notes ?? ""}`;
    })
    .join("\n");
}
