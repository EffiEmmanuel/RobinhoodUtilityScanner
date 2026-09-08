import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Only used by the Prisma CLI (generate/db push/studio) — `generate`
    // doesn't need a live connection, so this placeholder keeps `prisma
    // generate` working during the Docker build with no DATABASE_URL set.
    // The running app itself reads DATABASE_URL directly (see src/db.ts)
    // and fails loudly if it's actually missing.
    url: process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
});
