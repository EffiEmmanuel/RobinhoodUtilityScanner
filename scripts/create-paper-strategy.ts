import { db } from "../src/db";
import { USER_BRACKETS, parseSizing } from "../src/trading/paper/strategyConfig";

/**
 * One-off, human-run: creates (or updates) a paper strategy row. Rows are
 * created INACTIVE; pass --activate to switch one on. The paper loop also
 * needs PAPER_STRATEGIES_ENABLED=true on the service.
 *
 *   railway run -- npx tsx scripts/create-paper-strategy.ts --name "V0 at decision" --version v1.8-good-project-unlimited-hold
 *   ... --sizing brackets | --sizing flat:5   --venue other   --start 21   --activate
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg("name");
  const version = arg("version");
  if (!name || !version) throw new Error("--name and --version are required");
  const sv = await db.strategyVersion.findFirst({ where: { OR: [{ id: version }, { version }] } });
  if (!sv) throw new Error(`no StrategyVersion with id or version ${version}`);
  const sizingArg = arg("sizing") ?? "brackets";
  const sizing = sizingArg === "brackets" ? USER_BRACKETS : parseSizing({ type: "flat", pct: Number(sizingArg.replace("flat:", "")) });
  if ("error" in sizing) throw new Error(sizing.error);
  const venue = arg("venue");
  const data = {
    chain: "solana",
    strategyVersionId: sv.id,
    entry: { type: "at-decision" },
    filter: venue ? { venue } : {},
    sizing: sizing as object,
    startEquityUsd: Number(arg("start") ?? 21),
    active: process.argv.includes("--activate"),
  };
  const row = await db.paperStrategy.upsert({ where: { name }, create: { name, ...data }, update: data });
  console.log(`${row.name} (${row.id}): ${sv.version}, ${row.active ? "ACTIVE" : "inactive"}`, JSON.stringify(data));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
