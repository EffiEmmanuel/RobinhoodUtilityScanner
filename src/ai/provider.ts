import { GoogleGenAI, ApiError, FunctionCallingConfigMode, type Part } from "@google/genai";
import type { z } from "zod";
import { config } from "../config";
import { logger } from "../logger";
import { sleep } from "../util/http";

const RETRY_BACKOFF_MS = [0, 2000, 8000];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

let client: GoogleGenAI | undefined;
function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

export interface ImageInput {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

/**
 * Calls Gemini with a forced function call so the response is guaranteed to
 * match `schema`, then validates it. Never trust free-form model text for app
 * logic (rules #4 and §12 in the PRD) — this is the only way AI output enters
 * the system.
 *
 * `jsonSchema` is passed via `parametersJsonSchema`, which accepts standard
 * (lowercase-type) JSON Schema directly — confirmed against the live API —
 * so the same schema objects work unchanged if a future provider swap needs them.
 */
export async function callStructured<T extends z.ZodTypeAny>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: T;
  jsonSchema: object;
  toolName: string;
  images?: ImageInput[];
  maxTokens?: number;
  /** 0 disables thinking, -1 is automatic. Omit for the model's default. */
  thinkingBudget?: number;
}): Promise<z.infer<T>> {
  const ai = getClient();

  const parts: Part[] = [];
  for (const img of opts.images ?? []) {
    parts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
  }
  parts.push({ text: opts.prompt });

  let lastErr: unknown;
  let call: NonNullable<Awaited<ReturnType<typeof ai.models.generateContent>>["functionCalls"]>[number] | undefined;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    if (RETRY_BACKOFF_MS[attempt]) await sleep(RETRY_BACKOFF_MS[attempt]);
    try {
      const response = await ai.models.generateContent({
        model: opts.model,
        contents: parts,
        config: {
          systemInstruction: opts.system,
          maxOutputTokens: opts.maxTokens ?? 1500,
          thinkingConfig: opts.thinkingBudget !== undefined ? { thinkingBudget: opts.thinkingBudget } : undefined,
          tools: [
            {
              functionDeclarations: [
                {
                  name: opts.toolName,
                  description: "Return the structured research/classification output.",
                  parametersJsonSchema: opts.jsonSchema,
                },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [opts.toolName] },
          },
        },
      });
      call = response.functionCalls?.find((c) => c.name === opts.toolName);
      break;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ApiError && RETRYABLE_STATUS.has(err.status);
      logger.warn({ toolName: opts.toolName, attempt, retryable, err: String(err) }, "Gemini call failed");
      if (!retryable) throw err;
    }
  }
  if (!call) {
    if (lastErr) throw lastErr;
    throw new Error(`Model did not return a ${opts.toolName} function call`);
  }

  const parsed = opts.schema.safeParse(call.args);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues, raw: call.args }, "AI output failed schema validation");
    throw new Error(`AI output for ${opts.toolName} failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function fetchImageAsBase64(url: string): Promise<ImageInput | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const contentType = res.headers.get("content-type") ?? "";
    const mediaType = ["image/png", "image/jpeg", "image/webp", "image/gif"].find((t) =>
      contentType.includes(t)
    ) as ImageInput["mediaType"] | undefined;
    if (!mediaType) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 5_000_000) return undefined;
    return { base64: buf.toString("base64"), mediaType };
  } catch (err) {
    logger.warn({ url, err: String(err) }, "failed to fetch image for classification");
    return undefined;
  }
}
