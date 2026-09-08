import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { config } from "../config";
import { logger } from "../logger";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

export interface ImageInput {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

/**
 * Calls Claude with a forced tool call so the response is guaranteed to match
 * `schema`, then validates it. Never trust free-form model text for app logic
 * (rules #4 and §12 in the PRD) — this is the only way AI output enters the system.
 */
export async function callStructured<T extends z.ZodTypeAny>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: T;
  jsonSchema: Anthropic.Tool.InputSchema;
  toolName: string;
  images?: ImageInput[];
  maxTokens?: number;
}): Promise<z.infer<T>> {
  const anthropic = getClient();

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const img of opts.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: "text", text: opts.prompt });

  const response = await anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1500,
    system: opts.system,
    messages: [{ role: "user", content }],
    tools: [
      {
        name: opts.toolName,
        description: "Return the structured research/classification output.",
        input_schema: opts.jsonSchema,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.toolName
  );
  if (!toolUse) {
    throw new Error(`Model did not return a ${opts.toolName} tool call`);
  }

  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues, raw: toolUse.input }, "AI output failed schema validation");
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
