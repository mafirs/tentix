import { createFileRoute } from "@tanstack/react-router";
import { PaginatedDataTable } from "@comp/tickets-table/paginated-table.tsx";
import { StaffSidebar } from "@comp/staff/sidebar";
import { Suspense } from "react";
import { SkeletonTable } from "@comp/tickets-table/skeleton";
import { userTablePagination } from "@store/table-pagination";
import { RouteTransition } from "@comp/page-transition";

export const Route = createFileRoute("/staff/tickets/list")({
  beforeLoad: () => {
    userTablePagination
      .getState()
      .initializeDefaultStatuses(["pending", "in_progress"]);
    return {};
  },
  head: () => ({
    meta: [
      {
        title: "工单列表 | Tentix",
      },
    ],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <RouteTransition>
      <div className="flex h-screen w-full overflow-hidden">
        <StaffSidebar />
        <Suspense fallback={<SkeletonTable />}>
          <PaginatedDataTable character="staff" />
        </Suspense>
      </div>
    </RouteTransition>
  );
}
