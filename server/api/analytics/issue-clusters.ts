import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi/zod";
import type { AuthEnv } from "../middleware.ts";
import { issueClustersQuerySchema } from "./schemas.ts";
import {
  getIssueClusters,
  runManualIssueCluster,
} from "@/utils/analytics/issue-clusters.ts";
import { logError } from "@/utils/log.ts";

export const issueClustersRouter = new Hono<AuthEnv>()
  .get(
    "/issue-clusters",
    describeRoute({
      description: "Get frequent issue clusters",
      tags: ["Analytics"],
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Frequent issue cluster data" } },
    }),
    zValidator("query", issueClustersQuerySchema),
    async (c) => {
      const db = c.var.db;
      const { window } = c.req.valid("query");
      return c.json(await getIssueClusters(db, window));
    },
  )
  .post(
    "/issue-clusters/manual-run",
    describeRoute({
      description: "Generate latest rolling seven-day issue clusters",
      tags: ["Analytics"],
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Manual issue cluster run result" } },
    }),
    async (c) => {
      const db = c.var.db;
      try {
        const result = await runManualIssueCluster(db);
        return c.json({ status: "ok", ...result });
      } catch (error) {
        logError("[issue-clusters] manual run failed", error);
        throw error;
      }
    },
  );
