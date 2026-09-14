import "dotenv/config";
import { Pool, type QueryResultRow } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const rawPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

export async function rawQuery<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await rawPool.query<T>(text, values);
  return result.rows;
}
