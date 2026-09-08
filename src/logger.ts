import pino from "pino";
import { config } from "./config";

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
