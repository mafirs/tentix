import { Cron } from "croner";
import { connectDB } from "@/utils/tools";
import { logInfo, logWarning } from "@/utils/log";
import {
  getScheduledCatchUpRanges,
  runIssueClusterForRange,
  runScheduledIssueCluster,
} from "@/utils/analytics/issue-clusters.ts";

const ISSUE_CLUSTER_SCHEDULER = {
  TIMEZONE: "Asia/Shanghai",
} as const;

export function weeklyIssueClusterJob() {
  const pattern = "0 0 3 * * 1";
  const job = new Cron(
    pattern,
    {
      name: "weekly-issue-cluster",
      timezone: ISSUE_CLUSTER_SCHEDULER.TIMEZONE,
      protect: true,
      unref: true,
    },
    async () => {
      const db = connectDB();
      try {
        const catchUpRanges = await getScheduledCatchUpRanges(db);
        for (const range of catchUpRanges) {
          try {
            await runIssueClusterForRange(db, { ...range, runType: "scheduled" });
          } catch (error) {
            logWarning(`[weekly-issue-cluster] catch-up failed week=${range.weekStart}, error=${String(error)}`);
          }
        }
        const result = await runScheduledIssueCluster(db);
        logInfo(`[weekly-issue-cluster] completed: clusters=${result.clusterCount}, tickets=${result.ticketCount}`);
      } catch (err) {
        logWarning(`[weekly-issue-cluster] failed: ${String(err)}`);
      }
    },
  );
  return job;
}
