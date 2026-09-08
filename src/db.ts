import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma";
import { config } from "./config";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (expected a postgresql:// connection string) — see .env.example");
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const db = new PrismaClient({
  adapter,
  log: config.nodeEnv === "development" ? ["warn", "error"] : ["error"],
});
