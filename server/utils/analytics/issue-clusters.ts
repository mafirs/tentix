import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import * as schema from "@db/schema.ts";
import { connectDB } from "@/utils/tools.ts";
import { OPENAI_CONFIG } from "@/utils/kb/config.ts";
import { extractTextWithoutImages } from "@/utils/kb/tools.ts";
import { logWarning } from "@/utils/log.ts";

type DB = ReturnType<typeof connectDB>;
export type IssueClusterWindow = "7d" | "30d" | "90d" | "live";
export type IssueClusterRunType = "scheduled" | "backfill" | "manual";

const PRODUCTION_RUN_TYPES: IssueClusterRunType[] = ["scheduled", "backfill"];
const MIN_WEEKLY_CLUSTER_COUNT = 2;
const MIN_WINDOW_DISPLAY_COUNT = 3;
const CANONICAL_MATCH_THRESHOLD = 0.7;
const AI_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_WEEKS = 26;
const MAX_SCHEDULED_CATCH_UP_WEEKS = 2;
const STALE_RUNNING_RUN_MS = 2 * 60 * 60 * 1000;

const weeklyClusterSchema = z.object({
  clusters: z.array(
    z.object({
      summary: z.string().min(6).max(254),
      ticketIds: z.array(z.string().length(13)).min(MIN_WEEKLY_CLUSTER_COUNT),
      representativeTicketId: z.string().length(13),
      module: z.string().max(50).default(""),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const canonicalMatchSchema = z.object({
  matches: z.array(
    z.object({
      clusterKey: z.string(),
      canonicalId: z.number().nullable(),
      confidence: z.number().min(0).max(1),
      isNew: z.boolean(),
    }),
  ),
});

type WeeklyClusterLLMResult = z.infer<typeof weeklyClusterSchema>["clusters"][number];
type WeeklyClusterWithKey = WeeklyClusterLLMResult & {
  stableKey: string;
  module: string;
};

interface TicketCorpusItem {
  id: string;
  title: string;
  descriptionText: string;
  module: string;
  createdAt: string;
}

interface RunIssueClusterOptions {
  start: Date;
  end: Date;
  weekStart: string;
  runType: IssueClusterRunType;
  replaceExistingBackfill?: boolean;
}

type IssueClusterTrend =
  | { type: "up" | "down" | "flat"; delta?: number }
  | { type: "new" }
  | null;

interface IssueClusterItem {
  id: string;
  canonicalId: number | null;
  summary: string;
  totalCount: number;
  module: string;
  firstSeenWeek: string;
  weeksSinceFirst: number;
  trend: IssueClusterTrend;
  perWeekCounts: number[];
  tickets: Array<{ id: string; title: string; snippet: string }>;
}

interface IssueClustersResponse {
  window: IssueClusterWindow;
  status: "ready" | "empty" | "pending";
  generatedAt?: string;
  dataThrough?: string;
  clusters: IssueClusterItem[];
  longTailCount: number;
}

function requireAnalysisModel() {
  if (!OPENAI_CONFIG.apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (!OPENAI_CONFIG.analysisModel) {
    throw new Error("ANALYSIS_MODEL is not configured");
  }
}

function createAnalysisModel() {
  return new ChatOpenAI({
    apiKey: OPENAI_CONFIG.apiKey,
    model: OPENAI_CONFIG.analysisModel,
    temperature: 0.2,
    configuration: {
      baseURL: OPENAI_CONFIG.baseURL,
    },
  });
}

async function withRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await Promise.race([
        task(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout`)), AI_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      lastError = err;
      logWarning(`[issue-clusters] ${label} failed: attempt=${attempt}, error=${String(err)}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function toShanghaiDate(date: Date) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS);
}

function fromShanghaiDateStart(dateString: string) {
  return new Date(`${dateString}T00:00:00.000+08:00`);
}

function toDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function getWeekStartShanghai(date: Date): string {
  const shanghai = toShanghaiDate(date);
  const day = shanghai.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  shanghai.setUTCDate(shanghai.getUTCDate() + diff);
  return toDateString(shanghai);
}

export function getPreviousCompletedWeekRange(now = new Date()) {
  const thisWeekStart = fromShanghaiDateStart(getWeekStartShanghai(now));
  const previousWeekStart = new Date(thisWeekStart);
  previousWeekStart.setUTCDate(previousWeekStart.getUTCDate() - 7);
  return {
    start: previousWeekStart,
    end: thisWeekStart,
    weekStart: toDateString(toShanghaiDate(previousWeekStart)),
  };
}

export function getRollingSevenDaysRange(now = new Date()) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 7);
  return {
    start,
    end: now,
    weekStart: toDateString(toShanghaiDate(start)),
  };
}

export function getDefaultBackfillRanges(now = new Date()) {
  const latest = getPreviousCompletedWeekRange(now);
  const ranges: Array<{ start: Date; end: Date; weekStart: string }> = [];
  for (let index = DEFAULT_BACKFILL_WEEKS - 1; index >= 0; index--) {
    const start = new Date(latest.start);
    start.setUTCDate(start.getUTCDate() - index * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    ranges.push({
      start,
      end,
      weekStart: toDateString(toShanghaiDate(start)),
    });
  }
  return ranges;
}

export function assertShanghaiMonday(date: Date, argName: string) {
  const shanghai = toShanghaiDate(date);
  if (shanghai.getUTCDay() !== 1) {
    throw new Error(`${argName} must be a Monday in Asia/Shanghai`);
  }
}

async function collectTicketsForRange(db: DB, start: Date, end: Date): Promise<TicketCorpusItem[]> {
  const tickets = await db
    .select({
      id: schema.tickets.id,
      title: schema.tickets.title,
      description: schema.tickets.description,
      module: schema.tickets.module,
      createdAt: schema.tickets.createdAt,
    })
    .from(schema.tickets)
    .where(
      and(
        gte(schema.tickets.createdAt, start.toISOString()),
        lt(schema.tickets.createdAt, end.toISOString()),
      ),
    )
    .orderBy(asc(schema.tickets.createdAt));

  return tickets.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    descriptionText: extractTextWithoutImages(ticket.description),
    module: ticket.module,
    createdAt: ticket.createdAt,
  }));
}

function createStableKey(ticketIds: string[]) {
  return ticketIds.slice().sort().join("|").slice(0, 254);
}

async function runWeeklyClustering(tickets: TicketCorpusItem[]): Promise<WeeklyClusterWithKey[]> {
  if (tickets.length < MIN_WEEKLY_CLUSTER_COUNT) {
    return [];
  }
  const corpus = tickets
    .map((ticket) =>
      [
        `ticketId: ${ticket.id}`,
        `module: ${ticket.module}`,
        `title: ${ticket.title}`,
        `description: ${ticket.descriptionText || "(empty)"}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
  const structured = createAnalysisModel().withStructuredOutput(weeklyClusterSchema);
  const result = await withRetry("weekly clustering", () =>
    structured.invoke([
      { role: "system", content: "你是 Sealos 工单系统的问题聚簇分析助手。" },
      {
        role: "user",
        content: `请归纳频发问题簇。每簇至少 ${MIN_WEEKLY_CLUSTER_COUNT} 个真实 ticketId，只能使用输入 ticketId，summary 必须是具体问题句。\n\n${corpus}`,
      },
    ]),
  );
  const validTicketIds = new Set(tickets.map((ticket) => ticket.id));
  return result.clusters
    .filter(
      (cluster) =>
        cluster.ticketIds.length >= MIN_WEEKLY_CLUSTER_COUNT &&
        cluster.ticketIds.every((ticketId) => validTicketIds.has(ticketId)),
    )
    .map((cluster) => ({
      ...cluster,
      module: cluster.module || "",
      stableKey: createStableKey(cluster.ticketIds),
    }));
}

async function matchCanonicalIds(db: DB, clusters: WeeklyClusterWithKey[]) {
  const activeCanonicals = await db
    .select({
      id: schema.issueCanonical.id,
      title: schema.issueCanonical.title,
      summary: schema.issueCanonical.summary,
      primaryModule: schema.issueCanonical.primaryModule,
      totalCount: schema.issueCanonical.totalCount,
    })
    .from(schema.issueCanonical)
    .where(eq(schema.issueCanonical.status, "active"))
    .limit(200);
  if (activeCanonicals.length === 0) {
    return clusters.map((cluster) => ({
      cluster,
      canonicalId: null,
      confidence: 1,
      needsReview: false,
    }));
  }
  const structured = createAnalysisModel().withStructuredOutput(canonicalMatchSchema);
  const result = await withRetry("canonical matching", () =>
    structured.invoke([
      {
        role: "system",
        content: "你负责判断本周问题簇是否属于历史问题身份。按 clusterKey 返回匹配结果。",
      },
      {
        role: "user",
        content: JSON.stringify({
          clusters: clusters.map((cluster) => ({
            clusterKey: cluster.stableKey,
            summary: cluster.summary,
            module: cluster.module,
            ticketIds: cluster.ticketIds,
          })),
          activeCanonicals,
        }),
      },
    ]),
  );
  const matchesByKey = new Map(result.matches.map((match) => [match.clusterKey, match]));
  const activeCanonicalIds = new Set(activeCanonicals.map((canonical) => canonical.id));
  return clusters.map((cluster) => {
    const match = matchesByKey.get(cluster.stableKey);
    const confidence = match?.confidence ?? 0;
    const canonicalId = match &&
      !match.isNew &&
      match.canonicalId &&
      activeCanonicalIds.has(match.canonicalId) &&
      confidence >= CANONICAL_MATCH_THRESHOLD
      ? match.canonicalId
      : null;
    return {
      cluster,
      canonicalId,
      confidence,
      needsReview: Boolean(match && !match.isNew && confidence < CANONICAL_MATCH_THRESHOLD),
    };
  });
}

async function recomputeCanonicalStats(db: DB, canonicalIds: number[]) {
  for (const canonicalId of [...new Set(canonicalIds)]) {
    const rows = await db
      .select({
        weekStart: schema.weeklyIssueCluster.weekStart,
        count: schema.weeklyIssueCluster.count,
        runAt: schema.weeklyIssueCluster.runAt,
      })
      .from(schema.weeklyIssueCluster)
      .where(
        and(
          eq(schema.weeklyIssueCluster.canonicalId, canonicalId),
          inArray(schema.weeklyIssueCluster.runType, PRODUCTION_RUN_TYPES),
        ),
      )
      .orderBy(desc(schema.weeklyIssueCluster.weekStart), desc(schema.weeklyIssueCluster.runAt));
    const latestByWeek = new Map<string, { weekStart: string; count: number }>();
    for (const row of rows) {
      if (!latestByWeek.has(row.weekStart)) {
        latestByWeek.set(row.weekStart, row);
      }
    }
    const effectiveRows = Array.from(latestByWeek.values()).sort((a, b) =>
      a.weekStart.localeCompare(b.weekStart),
    );
    if (effectiveRows.length === 0) {
      await db
        .update(schema.issueCanonical)
        .set({
          totalCount: 0,
          status: "archived",
        })
        .where(eq(schema.issueCanonical.id, canonicalId));
      continue;
    }
    const firstSeen = effectiveRows[0]!.weekStart;
    const lastSeen = effectiveRows[effectiveRows.length - 1]!.weekStart;
    const totalCount = effectiveRows.reduce((sum, row) => sum + row.count, 0);
    await db
      .update(schema.issueCanonical)
      .set({
        totalCount,
        firstSeenWeek: firstSeen,
        lastSeenWeek: lastSeen,
        status: "active",
      })
      .where(eq(schema.issueCanonical.id, canonicalId));
  }
}

export async function runIssueClusterForRange(db: DB, options: RunIssueClusterOptions) {
  const runAt = new Date().toISOString();
  const insertedRun = await db
    .insert(schema.issueClusterRun)
    .values({
      weekStart: options.weekStart,
      runType: options.runType,
      status: "running",
      runAt,
    })
    .returning({ id: schema.issueClusterRun.id });
  const runId = insertedRun[0]!.id;
  try {
    requireAnalysisModel();
    const tickets = await collectTicketsForRange(db, options.start, options.end);
    const clusters = await runWeeklyClustering(tickets);
    const matched = options.runType === "manual"
      ? clusters.map((cluster) => ({
          cluster,
          canonicalId: null,
          confidence: cluster.confidence,
          needsReview: false,
        }))
      : await matchCanonicalIds(db, clusters);
    const touchedCanonicalIds: number[] = [];
    await db.transaction(async (tx) => {
      if (options.runType === "backfill" && options.replaceExistingBackfill) {
        const oldRuns = await tx
          .select({ id: schema.issueClusterRun.id })
          .from(schema.issueClusterRun)
          .where(
            and(
              eq(schema.issueClusterRun.weekStart, options.weekStart),
              eq(schema.issueClusterRun.runType, "backfill"),
              ne(schema.issueClusterRun.id, runId),
            ),
          );
        const oldRunIds = oldRuns.map((row) => row.id);
        if (oldRunIds.length > 0) {
          const oldCanonicalRows = await tx
            .select({ canonicalId: schema.weeklyIssueCluster.canonicalId })
            .from(schema.weeklyIssueCluster)
            .where(inArray(schema.weeklyIssueCluster.runId, oldRunIds));
          touchedCanonicalIds.push(
            ...oldCanonicalRows
              .map((row) => row.canonicalId)
              .filter((id): id is number => typeof id === "number"),
          );
          await tx.delete(schema.weeklyIssueCluster).where(inArray(schema.weeklyIssueCluster.runId, oldRunIds));
          await tx.delete(schema.issueClusterRun).where(inArray(schema.issueClusterRun.id, oldRunIds));
        }
      }
      for (const item of matched) {
        let canonicalId = item.canonicalId;
        if (!canonicalId && options.runType !== "manual") {
          const inserted = await tx
            .insert(schema.issueCanonical)
            .values({
              title: item.cluster.summary.slice(0, 254),
              summary: item.cluster.summary,
              primaryModule: item.cluster.module || "",
              firstSeenWeek: options.weekStart,
              lastSeenWeek: options.weekStart,
              totalCount: item.cluster.ticketIds.length,
            })
            .returning({ id: schema.issueCanonical.id });
          canonicalId = inserted[0]!.id;
        }
        if (canonicalId) {
          touchedCanonicalIds.push(canonicalId);
        }
        await tx.insert(schema.weeklyIssueCluster).values({
          runId,
          weekStart: options.weekStart,
          runType: options.runType,
          runAt,
          canonicalId,
          stableKey: item.cluster.stableKey,
          summary: item.cluster.summary,
          count: item.cluster.ticketIds.length,
          ticketIds: item.cluster.ticketIds,
          representativeTicketId: item.cluster.representativeTicketId,
          avgConfidence: item.cluster.confidence,
          module: item.cluster.module || "",
          needsReview: item.needsReview,
        });
      }
      await tx
        .update(schema.issueClusterRun)
        .set({
          status: clusters.length === 0 ? "empty" : "success",
          completedAt: new Date().toISOString(),
          ticketCount: tickets.length,
          clusterCount: clusters.length,
        })
        .where(eq(schema.issueClusterRun.id, runId));
    });
    await recomputeCanonicalStats(db, touchedCanonicalIds);
    return { runAt, clusterCount: clusters.length, ticketCount: tickets.length };
  } catch (error) {
    await db
      .update(schema.issueClusterRun)
      .set({
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: String(error).slice(0, 1000),
      })
      .where(eq(schema.issueClusterRun.id, runId));
    throw error;
  }
}

export async function runScheduledIssueCluster(db: DB, now = new Date()) {
  const range = getPreviousCompletedWeekRange(now);
  return runIssueClusterForRange(db, { ...range, runType: "scheduled" });
}

export async function runManualIssueCluster(db: DB, now = new Date()) {
  const range = getRollingSevenDaysRange(now);
  return runIssueClusterForRange(db, { ...range, runType: "manual" });
}

export async function getScheduledCatchUpRanges(db: DB, now = new Date()) {
  const ranges = getDefaultBackfillRanges(now).slice(-MAX_SCHEDULED_CATCH_UP_WEEKS - 1, -1);
  const result = [];
  for (const range of ranges) {
    const latestRun = await db.query.issueClusterRun.findFirst({
      where: and(
        eq(schema.issueClusterRun.weekStart, range.weekStart),
        eq(schema.issueClusterRun.runType, "scheduled"),
      ),
      orderBy: desc(schema.issueClusterRun.runAt),
    });
    const isStaleRunning = latestRun?.status === "running" &&
      Date.now() - Date.parse(latestRun.runAt) > STALE_RUNNING_RUN_MS;
    if (!latestRun || latestRun.status === "failed" || isStaleRunning) {
      result.push(range);
    }
  }
  return result.slice(0, MAX_SCHEDULED_CATCH_UP_WEEKS);
}

const WINDOW_RUN_LIMIT: Record<Exclude<IssueClusterWindow, "live">, number> = {
  "7d": 1,
  "30d": 5,
  "90d": 13,
};

type IssueClusterRunRow = typeof schema.issueClusterRun.$inferSelect;

async function getRunsForWindow(db: DB, window: IssueClusterWindow) {
  if (window === "live") {
    const latestManualRun = await db.query.issueClusterRun.findFirst({
      where: and(
        eq(schema.issueClusterRun.runType, "manual"),
        inArray(schema.issueClusterRun.status, ["success", "empty"]),
      ),
      orderBy: desc(schema.issueClusterRun.runAt),
    });
    return {
      currentRuns: latestManualRun ? [latestManualRun] : [],
      previousRuns: [],
    };
  }

  const limit = WINDOW_RUN_LIMIT[window];
  const rows = await db
    .select()
    .from(schema.issueClusterRun)
    .where(
      and(
        inArray(schema.issueClusterRun.runType, PRODUCTION_RUN_TYPES),
        inArray(schema.issueClusterRun.status, ["success", "empty"]),
      ),
    )
    .orderBy(desc(schema.issueClusterRun.weekStart), desc(schema.issueClusterRun.runAt))
    .limit(limit * 2 + 8);

  const latestRunByWeek = new Map<string, IssueClusterRunRow>();
  for (const row of rows) {
    if (!latestRunByWeek.has(row.weekStart)) {
      latestRunByWeek.set(row.weekStart, row);
    }
  }
  const orderedRuns = Array.from(latestRunByWeek.values()).sort((a, b) =>
    b.weekStart.localeCompare(a.weekStart),
  );
  return {
    currentRuns: orderedRuns.slice(0, limit).reverse(),
    previousRuns: orderedRuns.slice(limit, limit * 2).reverse(),
  };
}

function getGroupId(row: { runId: number; canonicalId: number | null; stableKey: string }, mergedInto?: number | null) {
  const effectiveCanonicalId = row.canonicalId ? (mergedInto ?? row.canonicalId) : null;
  return effectiveCanonicalId ? `canonical-${effectiveCanonicalId}` : `manual-${row.runId}-${row.stableKey}`;
}

function calculateTrend(current: number, previous: number | undefined, hasFullPreviousWindow: boolean): IssueClusterTrend {
  if (!hasFullPreviousWindow) {
    return null;
  }
  if (!previous) {
    return { type: "new" };
  }
  const delta = (current - previous) / previous;
  if (Math.abs(delta) < 0.1) {
    return { type: "flat", delta };
  }
  return { type: delta > 0 ? "up" : "down", delta };
}

function weeksBetween(fromWeekStart: string, toWeekStart: string) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((Date.parse(toWeekStart) - Date.parse(fromWeekStart)) / weekMs));
}

async function fetchClusterRows(db: DB, runs: IssueClusterRunRow[]) {
  if (runs.length === 0) {
    return [];
  }
  return db
    .select({
      id: schema.weeklyIssueCluster.id,
      runId: schema.weeklyIssueCluster.runId,
      weekStart: schema.weeklyIssueCluster.weekStart,
      runType: schema.weeklyIssueCluster.runType,
      canonicalId: schema.weeklyIssueCluster.canonicalId,
      stableKey: schema.weeklyIssueCluster.stableKey,
      summary: schema.weeklyIssueCluster.summary,
      count: schema.weeklyIssueCluster.count,
      ticketIds: schema.weeklyIssueCluster.ticketIds,
      module: schema.weeklyIssueCluster.module,
      canonicalMergedInto: schema.issueCanonical.mergedInto,
    })
    .from(schema.weeklyIssueCluster)
    .leftJoin(
      schema.issueCanonical,
      eq(schema.weeklyIssueCluster.canonicalId, schema.issueCanonical.id),
    )
    .where(inArray(schema.weeklyIssueCluster.runId, runs.map((run) => run.id)));
}

async function fetchCanonicalMap(db: DB, rows: Awaited<ReturnType<typeof fetchClusterRows>>) {
  const canonicalIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.canonicalId, row.canonicalMergedInto])
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  if (canonicalIds.length === 0) {
    return new Map<number, typeof schema.issueCanonical.$inferSelect>();
  }
  const canonicals = await db
    .select()
    .from(schema.issueCanonical)
    .where(inArray(schema.issueCanonical.id, canonicalIds));
  return new Map(canonicals.map((canonical) => [canonical.id, canonical]));
}

async function fetchTicketMap(db: DB, ticketIds: string[]) {
  const uniqueIds = [...new Set(ticketIds)];
  if (uniqueIds.length === 0) {
    return new Map<string, { id: string; title: string; snippet: string }>();
  }
  const tickets = await db
    .select({
      id: schema.tickets.id,
      title: schema.tickets.title,
      description: schema.tickets.description,
    })
    .from(schema.tickets)
    .where(inArray(schema.tickets.id, uniqueIds));
  return new Map(
    tickets.map((ticket) => [
      ticket.id,
      {
        id: ticket.id,
        title: ticket.title,
        snippet: extractTextWithoutImages(ticket.description).slice(0, 160),
      },
    ]),
  );
}

async function buildClusterResponse(
  db: DB,
  window: IssueClusterWindow,
  currentRuns: IssueClusterRunRow[],
  previousRuns: IssueClusterRunRow[],
): Promise<IssueClustersResponse> {
  if (currentRuns.length === 0) {
    return { window, status: "pending", clusters: [], longTailCount: 0 };
  }
  const currentRows = await fetchClusterRows(db, currentRuns);
  const previousRows = await fetchClusterRows(db, previousRuns);
  const canonicalMap = await fetchCanonicalMap(db, [...currentRows, ...previousRows]);
  const currentWeeks = currentRuns.map((run) => run.weekStart);
  const latestWeek = currentWeeks[currentWeeks.length - 1]!;
  const generatedAt = currentRuns[currentRuns.length - 1]?.runAt;
  const previousTotals = new Map<string, number>();

  for (const row of previousRows) {
    const groupId = getGroupId(row, row.canonicalMergedInto);
    previousTotals.set(groupId, (previousTotals.get(groupId) ?? 0) + row.count);
  }

  const groups = new Map<
    string,
    {
      id: string;
      canonicalId: number | null;
      summary: string;
      module: string;
      firstSeenWeek: string;
      totalCount: number;
      ticketIds: string[];
      perWeekCounts: Map<string, number>;
    }
  >();

  for (const row of currentRows) {
    const groupId = getGroupId(row, row.canonicalMergedInto);
    const effectiveCanonicalId = row.canonicalId ? (row.canonicalMergedInto ?? row.canonicalId) : null;
    const canonical = effectiveCanonicalId ? canonicalMap.get(effectiveCanonicalId) : undefined;
    const group = groups.get(groupId) ?? {
      id: groupId,
      canonicalId: effectiveCanonicalId,
      summary: canonical?.summary ?? row.summary,
      module: canonical?.primaryModule || row.module || "",
      firstSeenWeek: canonical?.firstSeenWeek ?? row.weekStart,
      totalCount: 0,
      ticketIds: [],
      perWeekCounts: new Map<string, number>(),
    };
    group.totalCount += row.count;
    group.ticketIds.push(...(row.ticketIds as string[]));
    group.perWeekCounts.set(row.weekStart, (group.perWeekCounts.get(row.weekStart) ?? 0) + row.count);
    groups.set(groupId, group);
  }

  const displayGroups = Array.from(groups.values())
    .filter((group) => window === "live" || group.totalCount >= MIN_WINDOW_DISPLAY_COUNT)
    .sort((a, b) => b.totalCount - a.totalCount);
  const longTailCount = Array.from(groups.values())
    .filter((group) => window !== "live" && group.totalCount < MIN_WINDOW_DISPLAY_COUNT)
    .reduce((sum, group) => sum + group.totalCount, 0);
  const ticketMap = await fetchTicketMap(
    db,
    displayGroups.flatMap((group) => group.ticketIds).slice(0, 200),
  );
  const hasFullPreviousWindow = window !== "live" && previousRuns.length === currentRuns.length;
  const clusters = displayGroups.map((group) => ({
    id: group.id,
    canonicalId: group.canonicalId,
    summary: group.summary,
    totalCount: group.totalCount,
    module: group.module,
    firstSeenWeek: group.firstSeenWeek,
    weeksSinceFirst: weeksBetween(group.firstSeenWeek, latestWeek),
    trend: calculateTrend(group.totalCount, previousTotals.get(group.id), hasFullPreviousWindow),
    perWeekCounts: currentWeeks.map((weekStart) => group.perWeekCounts.get(weekStart) ?? 0),
    tickets: [...new Set(group.ticketIds)]
      .map((ticketId) => ticketMap.get(ticketId))
      .filter((ticket): ticket is { id: string; title: string; snippet: string } => Boolean(ticket))
      .slice(0, 5),
  }));

  return {
    window,
    status: clusters.length > 0 ? "ready" : "empty",
    generatedAt,
    dataThrough: latestWeek,
    clusters,
    longTailCount,
  };
}

export async function getIssueClusters(db: DB, window: IssueClusterWindow) {
  const { currentRuns, previousRuns } = await getRunsForWindow(db, window);
  return buildClusterResponse(db, window, currentRuns, previousRuns);
}
