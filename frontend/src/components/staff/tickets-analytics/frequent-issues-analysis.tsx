import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Badge, Button, cn } from "tentix-ui";
import {
  issueClustersQueryOptions,
  runIssueClustersManualRun,
  type IssueClusterTrend,
  type IssueClusterWindow,
} from "@lib/analytics-query";

const WINDOWS: Array<{ value: IssueClusterWindow; label: string }> = [
  { value: "7d", label: "本周" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
  { value: "live", label: "实时" },
];

function formatTrend(trend: IssueClusterTrend) {
  if (!trend) return "—";
  if (trend.type === "new") return "NEW";
  if (trend.type === "flat") return "持平";
  const sign = trend.type === "up" ? "+" : "-";
  const value = Math.round(Math.abs(trend.delta || 0) * 100);
  return `${sign}${value}%`;
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-6 items-end gap-1">
      {values.map((value, index) => (
        <div
          key={`${value}-${index}`}
          className="w-1.5 rounded-sm bg-blue-500"
          style={{ height: `${Math.max(4, (value / max) * 24)}px` }}
        />
      ))}
    </div>
  );
}

export function FrequentIssuesAnalysis() {
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<IssueClusterWindow>("30d");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useQuery(
    issueClustersQueryOptions(window),
  );
  const manualRunMutation = useMutation({
    mutationFn: runIssueClustersManualRun,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["issueClusters"] });
      setWindow("live");
    },
  });
  const response = data;
  const clusters = response?.clusters ?? [];
  return (
    <div className="w-full rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-6">
        <div>
          <h2 className="text-xl text-zinc-900">频发问题分析</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {response?.dataThrough ? `数据截至 ${response.dataThrough}` : "按已生成快照展示"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-1">
            {WINDOWS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setWindow(item.value)}
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-zinc-600",
                  window === item.value && "bg-white text-zinc-900 shadow-sm",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          {window === "live" && (
            <Button
              type="button"
              size="sm"
              onClick={() => manualRunMutation.mutate()}
              disabled={manualRunMutation.isPending}
            >
              {manualRunMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-2 h-4 w-4" />
              )}
              生成最新 7 天
            </Button>
          )}
        </div>
      </div>
      {isLoading ? (
        <div className="p-6">
          <div className="h-20 animate-pulse rounded-lg bg-zinc-100" />
        </div>
      ) : isError ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle className="h-10 w-10 text-orange-500" />
          <p className="text-base text-zinc-900">频发问题数据加载失败</p>
          <p className="text-sm text-zinc-500">
            {error instanceof Error ? error.message : "请稍后重试"}
          </p>
        </div>
      ) : clusters.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 p-6 text-center">
          <RefreshCw className="h-10 w-10 text-zinc-400" />
          <p className="text-base text-zinc-900">
            {window === "live" ? "还没有实时分析结果" : "当前窗口暂无频发问题"}
          </p>
          {window === "live" && (
            <Button
              type="button"
              onClick={() => manualRunMutation.mutate()}
              disabled={manualRunMutation.isPending}
            >
              生成最新 7 天
            </Button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-zinc-100">
          {clusters.map((cluster, index) => {
            const expanded = expandedId === cluster.id || (expandedId === null && index === 0);
            return (
              <div key={cluster.id} className="p-5">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? "" : cluster.id)}
                  className="flex w-full items-start justify-between gap-4 text-left"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    {expanded ? (
                      <ChevronDown className="mt-1 h-4 w-4 text-zinc-500" />
                    ) : (
                      <ChevronRight className="mt-1 h-4 w-4 text-zinc-500" />
                    )}
                    <div className="min-w-0">
                      <p className="text-base font-medium text-zinc-900">{cluster.summary}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
                        <span>{cluster.module || "未标模块"}</span>
                        <span>首次 {cluster.weeksSinceFirst} 周前</span>
                        <Sparkline values={cluster.perWeekCounts} />
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">{cluster.totalCount} 次</Badge>
                    <Badge variant="outline">{formatTrend(cluster.trend)}</Badge>
                  </div>
                </button>
                {expanded && (
                  <div className="mt-4 space-y-3 pl-7">
                    {cluster.tickets.map((ticket) => (
                      <Link
                        key={ticket.id}
                        to="/staff/tickets/$id"
                        params={{ id: ticket.id }}
                        className="block rounded-md border border-zinc-100 p-3 hover:bg-zinc-50"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 truncate text-sm font-medium text-zinc-900">
                            [{ticket.id}] {ticket.title}
                          </p>
                          <ExternalLink className="h-4 w-4 shrink-0 text-zinc-400" />
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{ticket.snippet}</p>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {Boolean(response?.longTailCount) && (
            <div className="p-5 text-sm text-zinc-500">
              其他长尾问题约 {response?.longTailCount} 次
            </div>
          )}
        </div>
      )}
    </div>
  );
}
