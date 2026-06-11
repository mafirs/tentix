import { connectDB } from "@/utils/tools.ts";
import { logComplete, logError, logInfo, logWarning } from "@/utils/log.ts";
import {
  assertShanghaiMonday,
  getDefaultBackfillRanges,
  runIssueClusterForRange,
} from "@/utils/analytics/issue-clusters.ts";

function getArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseDateArg(name: string) {
  const value = getArg(name);
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000+08:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  assertShanghaiMonday(date, `--${name}`);
  return date;
}

function toShanghaiDateString(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getRangesFromArgs() {
  const from = parseDateArg("from");
  const to = parseDateArg("to");
  if (!from && !to) {
    return getDefaultBackfillRanges();
  }
  if (!from || !to) {
    throw new Error("--from and --to must be provided together");
  }
  const ranges: Array<{ start: Date; end: Date; weekStart: string }> = [];
  for (const cursor = new Date(from); cursor < to; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setUTCDate(end.getUTCDate() + 7);
    ranges.push({ start, end, weekStart: toShanghaiDateString(start) });
  }
  return ranges;
}

async function main() {
  if (!process.argv.includes("--backfill")) {
    throw new Error("Only --backfill is supported by this script");
  }
  const replace = process.argv.includes("--replace");
  const db = connectDB();
  const failedWeeks: string[] = [];
  for (const range of getRangesFromArgs()) {
    try {
      logInfo(`[issue-clusters:backfill] running week=${range.weekStart}`);
      await runIssueClusterForRange(db, {
        ...range,
        runType: "backfill",
        replaceExistingBackfill: replace,
      });
    } catch (error) {
      failedWeeks.push(range.weekStart);
      logWarning(`[issue-clusters:backfill] failed week=${range.weekStart}, error=${String(error)}`);
    }
  }
  if (failedWeeks.length > 0) {
    logError(`[issue-clusters:backfill] failed weeks: ${failedWeeks.join(", ")}`);
    process.exit(1);
  }
  logComplete("[issue-clusters:backfill] completed");
}

main().catch((error) => {
  logError("[issue-clusters:backfill] aborted", error);
  process.exit(1);
});
