#!/usr/bin/env bun

/**
 * Check freshness of each source in the deep-context database.
 *
 * Usage: bun source-health.ts
 * Prints a summary table with message counts, last extraction time, and staleness warnings.
 */

import { Database } from "bun:sqlite";

import { dirname, join } from "path";

// Toolkit-relative: skills/deep-context-reference/scripts/ -> toolkit root is three levels up.
const DB_PATH = process.env.DEEP_CONTEXT_DB || join(dirname(dirname(dirname(import.meta.dir))), "data/deep_context/deep_context.db");

interface SourceConfig {
  name: string;
  staleAfterDays: number;
}

const SOURCES: SourceConfig[] = [
  { name: "gmail",     staleAfterDays: 3 },
  { name: "slack",     staleAfterDays: 3 },
  { name: "slack-dm",  staleAfterDays: 3 },
  { name: "beeper",    staleAfterDays: 3 },
  { name: "twitter",   staleAfterDays: 7 },
  { name: "calls",     staleAfterDays: 14 },
  { name: "podcast",   staleAfterDays: 14 },
];

interface SourceStats {
  source: string;
  count: number;
  newestTimestamp: string | null;
  daysSinceLast: number | null;
  staleAfterDays: number;
  isStale: boolean;
}

function getStats(db: Database): SourceStats[] {
  const now = Date.now();
  const results: SourceStats[] = [];

  for (const src of SOURCES) {
    const row = db.query<{ cnt: number; newest: string | null }, [string]>(
      `SELECT COUNT(*) as cnt, MAX(timestamp) as newest FROM messages WHERE source = ?`
    ).get(src.name);

    const count = row?.cnt ?? 0;
    const newest = row?.newest ?? null;

    let daysSinceLast: number | null = null;
    let isStale = false;

    if (newest) {
      const newestMs = new Date(newest).getTime();
      daysSinceLast = Math.round(((now - newestMs) / (1000 * 60 * 60 * 24)) * 10) / 10;
      isStale = daysSinceLast > src.staleAfterDays;
    } else {
      isStale = true; // No data at all counts as stale
    }

    results.push({
      source: src.name,
      count,
      newestTimestamp: newest,
      daysSinceLast,
      staleAfterDays: src.staleAfterDays,
      isStale,
    });
  }

  return results;
}

function formatTable(stats: SourceStats[]): string {
  const header = "Source       | Messages  | Last Message          | Days Ago | Threshold | Status";
  const sep =    "-------------|-----------|----------------------|----------|-----------|-------";
  const rows = stats.map(s => {
    const source = s.source.padEnd(12);
    const count = String(s.count).padStart(9);
    const newest = (s.newestTimestamp ?? "never").substring(0, 20).padEnd(20);
    const daysAgo = s.daysSinceLast !== null ? String(s.daysSinceLast).padStart(8) : "     N/A";
    const threshold = `${s.staleAfterDays}d`.padStart(9);
    const status = s.isStale ? "STALE" : "OK";
    return `${source} | ${count} | ${newest} | ${daysAgo} | ${threshold} | ${status}`;
  });

  return [header, sep, ...rows].join("\n");
}

// -- Main --
let db: Database;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e: any) {
  console.error(`Could not open database at ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

const stats = getStats(db);
db.close();

console.log("\nDeep Context Source Health Report");
console.log("================================\n");
console.log(formatTable(stats));

const stale = stats.filter(s => s.isStale);
if (stale.length > 0) {
  console.log(`\n${stale.length} source(s) are stale: ${stale.map(s => s.source).join(", ")}`);
} else {
  console.log("\nAll sources are fresh.");
}

const total = stats.reduce((sum, s) => sum + s.count, 0);
console.log(`\nTotal messages across tracked sources: ${total.toLocaleString()}\n`);
