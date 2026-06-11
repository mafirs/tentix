import { ticketAutoCloseJob } from "./ticketAutoClose";
import { ticketAutoPendingJob } from "./ticketAutoPending";
import { weeklyIssueClusterJob } from "./weeklyIssueCluster";

export function startTicketAutoCloseJob() {
  const autoCloseJob = ticketAutoCloseJob();
  const autoPendingJob = ticketAutoPendingJob();
  const issueClusterJob = weeklyIssueClusterJob();
  return { autoCloseJob, autoPendingJob, issueClusterJob };
}
