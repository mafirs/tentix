import * as schema from "@/db/schema.ts";
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi/zod";
import { z } from "zod";
import "zod-openapi/extend";
import {
  factory,
  authMiddleware,
  staffOnlyMiddleware,
  adminOnlyMiddleware,
} from "../middleware.ts";
import { emit, Events } from "@/utils/events/kb/bus";
import { HTTPException } from "hono/http-exception";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { logWarning } from "@/utils/log";
import { OPENAI_CONFIG, SOURCE_WEIGHTS } from "@/utils/kb/config";
import {
  loadEditedKnowledgeSourceContext,
  rebuildEditedKnowledgeMetadata,
} from "@/utils/kb/kb-builder";
import { getTextWithImageInfo } from "@/utils/kb/tools";
import type { JSONContentZod } from "@/utils/types";

const createFavoritedSchema = z.object({
  ticketId: z.string(),
  messageIds: z.array(z.number().int()).optional(),
  favoritedBy: z.number().int().positive(),
});

const createFavoritedResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({ id: z.number(), syncStatus: z.string() }),
});

const knowledgeSourceTypeValues = [
  "favorited_conversation",
  "historical_ticket",
  "general_knowledge",
] as const;

const knowledgeListQuerySchema = z
  .object({
    page: z.string().regex(/^\d+$/).optional(),
    pageSize: z.string().regex(/^\d+$/).optional(),
    keyword: z.string().optional(),
    sourceType: z.enum(["all", ...knowledgeSourceTypeValues]).optional(),
    module: z.string().optional(),
    status: z.enum(["all", "enabled", "disabled"]).optional(),
    failedOnly: z.enum(["true"]).optional(),
  })
  .strict();

const knowledgeSourceParamsSchema = z.object({
  sourceType: z.enum(knowledgeSourceTypeValues),
  sourceId: z.string().min(1),
});

const knowledgeUpdateSchema = z
  .object({
    chunks: z
      .array(
        z.object({
          id: z.string().uuid(),
          content: z.string().trim().min(1, "内容不能为空").max(20000),
        }),
      )
      .optional(),
  })
  .strict()
  .refine((value) => value.chunks !== undefined, {
    message: "至少提供一个要更新的片段",
  });

const generalKnowledgeSourceIdRegex =
  /^general_knowledge:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;

const generalKnowledgeCategoryValues = [
  "troubleshooting",
  "feature",
  "billing",
  "operation",
  "other",
] as const;

const generalKnowledgeSourcePartSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

const markdownGeneralKnowledgeDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  modules: z.array(z.string().trim().min(1).max(80)).max(10),
  category: z.enum(generalKnowledgeCategoryValues),
  content: z.string().trim().min(1).max(20000),
  indexes: z.array(z.string().trim().min(1).max(500)).max(3),
});

const createGeneralKnowledgeDraftFromMarkdownSchema = z
  .object({
    markdown: z.string().trim().min(1, "Markdown 内容不能为空").max(120000),
    docName: z.string().trim().min(1, "文档名不能为空").max(200),
    sourceDocId: generalKnowledgeSourcePartSchema,
    revision: z.string().trim().min(1, "版本不能为空").max(80),
    moduleOptions: z.array(z.string().trim().min(1).max(80)).max(80).optional(),
    maxCandidates: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const createGeneralKnowledgeSchema = z
  .object({
    sourceId: z
      .string()
      .trim()
      .regex(
        generalKnowledgeSourceIdRegex,
        "知识 ID 格式应为 general_knowledge:{source_doc_id}:{entry_slug}",
      )
      .max(200),
    title: z.string().trim().min(1, "标题不能为空").max(200),
    modules: z
      .array(z.string().trim().min(1).max(80))
      .min(1, "至少选择一个模块")
      .max(10, "模块数量不能超过 10 个"),
    category: z.enum(generalKnowledgeCategoryValues),
    docName: z.string().trim().max(200).optional(),
    revision: z.string().trim().min(1, "版本不能为空").max(80),
    content: z.string().trim().min(1, "正文不能为空").max(20000),
    indexes: z
      .array(z.string().trim().min(1).max(500))
      .max(3, "召回索引最多 3 条")
      .optional(),
  })
  .strict();

const createGeneralKnowledgeResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    sourceType: z.literal("general_knowledge"),
    sourceId: z.string(),
    chunkCount: z.number(),
  }),
});

const createGeneralKnowledgeDraftFromMarkdownResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    sourceDocId: z.string(),
    docName: z.string(),
    revision: z.string(),
    totalCandidates: z.number(),
    generatedCandidates: z.number(),
    skippedCandidates: z.number(),
    truncated: z.boolean(),
    maxCandidates: z.number(),
    items: z.array(
      z.object({
        draftId: z.string(),
        entrySlug: z.string(),
        titlePath: z.string(),
        sourceExcerpt: z.string(),
        title: z.string(),
        modules: z.array(z.string()),
        category: z.enum(generalKnowledgeCategoryValues),
        content: z.string(),
        indexes: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    ),
  }),
});

const knowledgeChunkParamsSchema = z.object({
  id: z.string().uuid(),
});

const knowledgeChunkUpdateSchema = z
  .object({
    isDeleted: z.boolean(),
  })
  .strict();

type KnowledgeListQuery = z.infer<typeof knowledgeListQuerySchema>;

const editedKnowledgeEmbedder = new OpenAIEmbeddings({
  apiKey: OPENAI_CONFIG.apiKey,
  model: OPENAI_CONFIG.embeddingModel,
  dimensions: 3072,
  configuration: {
    baseURL: OPENAI_CONFIG.baseURL,
  },
  batchSize: 16,
  timeout: 60_000,
  maxRetries: 3,
});

function hashKnowledgeContent({
  sourceType,
  sourceId,
  chunkId,
  content,
}: {
  sourceType: string;
  sourceId: string;
  chunkId: number;
  content: string;
}): string {
  return Bun.hash(`${sourceType}:${sourceId}:${chunkId}:${content}`).toString();
}

function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.map((x) => (Number.isFinite(x) ? Number(x).toFixed(6) : "0")).join(",")}]`;
}

async function embedEditedKnowledgeContent(text: string): Promise<string> {
  const input = text.replace(/\s+/g, " ").slice(0, 8000);
  const emb = await editedKnowledgeEmbedder.embedQuery(input);
  return toPgVectorLiteral(emb);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );
  return results;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function buildKnowledgeWhere(
  query: KnowledgeListQuery,
  failedSourceIds?: string[],
): SQL | undefined {
  const conditions: SQL[] = [];
  const sourceType = query.sourceType ?? "all";
  const keyword = query.keyword?.trim();
  const module = query.module?.trim();

  if (sourceType !== "all") {
    conditions.push(eq(schema.knowledgeBase.sourceType, sourceType));
  }

  if (module) {
    conditions.push(sql`(
      (${schema.knowledgeBase.sourceType} <> 'general_knowledge'
        AND ${schema.knowledgeBase.metadata} ->> 'module' = ${module})
      OR
      (${schema.knowledgeBase.sourceType} = 'general_knowledge'
        AND (
          ${schema.knowledgeBase.metadata} ->> 'module' = ${module}
          OR (${schema.knowledgeBase.metadata} -> 'modules') ? ${module}
        ))
    )`);
  }

  if (failedSourceIds) {
    conditions.push(eq(schema.knowledgeBase.sourceType, "favorited_conversation"));
    conditions.push(inArray(schema.knowledgeBase.sourceId, failedSourceIds));
  }

  if (keyword) {
    const pattern = `%${keyword}%`;
    const keywordCondition = or(
      ilike(schema.knowledgeBase.title, pattern),
      ilike(schema.knowledgeBase.content, pattern),
      ilike(schema.knowledgeBase.sourceId, pattern),
      sql`CAST(${schema.knowledgeBase.metadata} AS TEXT) ILIKE ${pattern}`,
    );
    if (keywordCondition) {
      conditions.push(keywordCondition);
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function buildKnowledgeStatusHaving(status: KnowledgeListQuery["status"]): SQL | undefined {
  const disabledCount = sql<number>`COALESCE(SUM(CASE WHEN ${schema.knowledgeBase.isDeleted} THEN 1 ELSE 0 END), 0)`;
  const totalCount = sql<number>`COUNT(*)`;
  if (status === "enabled") return sql`${disabledCount} < ${totalCount}`;
  if (status === "disabled") return sql`${disabledCount} > 0`;
  return undefined;
}

function getMetadataValue(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== "object") return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function getMetadataString(metadata: unknown, key: string): string {
  const value = getMetadataValue(metadata, key);
  return typeof value === "string" ? value : "";
}

function getMetadataStringArray(metadata: unknown, key: string): string[] {
  const value = getMetadataValue(metadata, key);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(
    new Set((values ?? []).map((item) => item.trim()).filter(Boolean)),
  );
}

function normalizeSourcePart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function makeStableSuffix(value: string): string {
  return Bun.hash(value).toString(36).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
}

type MarkdownImportCandidate = {
  draftId: string;
  entrySlug: string;
  titlePath: string;
  sourceExcerpt: string;
};

type MarkdownImportSplitResult = {
  candidates: MarkdownImportCandidate[];
  totalCandidates: number;
  generatedCandidates: number;
  skippedCandidates: number;
  truncated: boolean;
  maxCandidates: number;
};

function collectMarkdownHeadings(lines: string[]): Array<{
  level: number;
  title: string;
  lineIndex: number;
}> {
  return lines.flatMap((line, lineIndex) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match?.[1] || !match?.[2]) return [];
    return [{ level: match[1].length, title: match[2].trim(), lineIndex }];
  });
}

function buildTitlePath(
  headings: Array<{ level: number; title: string; lineIndex: number }>,
  currentIndex: number,
): string {
  const stack: Array<{ level: number; title: string }> = [];
  for (const heading of headings) {
    if (heading.lineIndex > currentIndex) break;
    while (stack.length && stack[stack.length - 1]!.level >= heading.level) {
      stack.pop();
    }
    stack.push({ level: heading.level, title: heading.title });
  }
  return stack.map((item) => item.title).join(" > ");
}

function splitMarkdownImportCandidates(
  markdown: string,
  maxCandidates: number,
): MarkdownImportSplitResult {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  const lines = normalized.split("\n");
  const headings = collectMarkdownHeadings(lines);
  if (headings.length === 0) {
    return {
      candidates: [
        {
          draftId: "draft-1",
          entrySlug: `entry-1-${makeStableSuffix(normalized)}`,
          titlePath: "未命名文档",
          sourceExcerpt: normalized.slice(0, 20000),
        },
      ],
      totalCandidates: 1,
      generatedCandidates: 1,
      skippedCandidates: 0,
      truncated: false,
      maxCandidates,
    };
  }

  const boundaryLevel = headings.some((heading) => heading.level === 2)
    ? 2
    : Math.min(...headings.map((heading) => heading.level));
  const allBoundaries = headings.filter((heading) => heading.level === boundaryLevel);
  const boundaries = allBoundaries.slice(0, maxCandidates);
  const totalCandidates = allBoundaries.length;
  const skippedCandidates = Math.max(0, totalCandidates - boundaries.length);

  return {
    totalCandidates,
    generatedCandidates: boundaries.length,
    skippedCandidates,
    truncated: skippedCandidates > 0,
    maxCandidates,
    candidates: boundaries.map((heading, index) => {
      const next = headings.find(
        (item) => item.lineIndex > heading.lineIndex && item.level === boundaryLevel,
      );
      const sourceExcerpt = lines
        .slice(heading.lineIndex, next?.lineIndex ?? lines.length)
        .join("\n")
        .trim();
      const titlePath = buildTitlePath(headings, heading.lineIndex) || heading.title;
      const slugBase = normalizeSourcePart(titlePath, `entry-${index + 1}`);
      return {
        draftId: `draft-${index + 1}`,
        entrySlug: `${slugBase}-${makeStableSuffix(titlePath)}`.slice(0, 80),
        titlePath,
        sourceExcerpt: sourceExcerpt.slice(0, 20000),
      };
    }),
  };
}

function normalizeGeneratedModules(
  modules: string[],
  allowedModules: string[],
): string[] {
  const normalized = normalizeStringList(modules).slice(0, 10);
  if (allowedModules.length === 0) return normalized;
  const allowed = new Set(allowedModules);
  return normalized.filter((item) => allowed.has(item));
}

async function structureMarkdownGeneralKnowledgeCandidate({
  candidate,
  allowedModules,
}: {
  candidate: MarkdownImportCandidate;
  allowedModules: string[];
}): Promise<MarkdownImportCandidate & z.infer<typeof markdownGeneralKnowledgeDraftSchema> & { warnings: string[] }> {
  const fallbackTitle = candidate.titlePath.split(" > ").pop() || candidate.titlePath;
  try {
    const model = new ChatOpenAI({
      apiKey: OPENAI_CONFIG.apiKey,
      model: OPENAI_CONFIG.summaryModel,
      configuration: {
        baseURL: OPENAI_CONFIG.baseURL,
      },
    });
    const structured = model.withStructuredOutput(markdownGeneralKnowledgeDraftSchema);
    const result = await structured.invoke([
      "请把以下 Markdown 片段结构化为一条通用知识草稿，只输出符合 schema 的结构化结果。",
      "",
      "## content",
      "content 是给 AI 客服直接执行的排障 runbook，不是摘要，不是回复用户的话术。",
      "- 以原文「标准流程（如何操作？）」小节为主体，逐步转录为 content，保留原文的每一条分支（若……则……）、每一条追问话术、每一个检查命令、每一条升级条件，不得合并为段落概括。",
      "- 如果原文没有名为「标准流程」的小节，以最接近操作步骤或诊断流程的部分为主体。",
      "- 原文里的具体话术（如「您好，请您确认下……」）和命令（如 `ss -tnlp`）必须原样保留，不得抽象为描述性文字。",
      "- 「关键注意事项与限制」中「必须先做 X」「不要先做 Y」类规则，附加到 content 末尾。",
      "- 不新增原文没有的事实，不擅自补充解决方案。",
      "",
      "## indexes",
      "indexes 模拟用户在问题还没解决、不知道原因时的真实提问。最多 3 条，覆盖不同表述角度。",
      "- 只描述用户感知到的症状，不写原因、不写结论、不写解决方案。",
      "- 用自然口语，避免出现用户不会主动说出的技术词（如「监听」「entrypoint」「ingress」「备案」）；产品功能名称（如「DevBox」「应用管理」「公网地址」）可以保留。",
      "- 例外：用户可能直接复制粘贴的报错信息（如 `exec format error`、`permission denied`、`command not found`）可以直接作为 index。",
      "- 用户通常不知道原因，index 里不能出现原因词，例如「自定义域名未备案导致准备中」是错误示范。",
      "- 同一症状覆盖不同说法：「准备中」「打不开」「访问不了」是同一类问题的不同表述，应各写一条。",
      "",
      "## category",
      "只能是 troubleshooting / feature / billing / operation / other。",
      "",
      allowedModules.length
        ? `## modules\n只能从以下模块代码中选择：${allowedModules.join(", ")}。\n标题路径是判断模块的最可靠依据，以标题路径中出现的模块名为首要参考。不确定时返回空数组。`
        : "## modules\n不确定时返回空数组。",
      "",
      `标题路径：${candidate.titlePath}`,
      "",
      "原始 Markdown 片段：",
      candidate.sourceExcerpt.slice(0, 12000),
    ].join("\n"));
    const modules = normalizeGeneratedModules(result.modules, allowedModules);
    const indexes = normalizeStringList(result.indexes).slice(0, 3);
    const warnings = [
      modules.length === 0 ? "未生成适用模块，请人工选择" : "",
      !result.content.trim() ? "未生成正式知识正文，请人工补充" : "",
    ].filter(Boolean);
    return {
      ...candidate,
      title: result.title.trim() || fallbackTitle,
      modules,
      category: result.category,
      content: result.content.trim() || candidate.sourceExcerpt,
      indexes,
      warnings,
    };
  } catch (err) {
    logWarning(`General knowledge Markdown draft generation failed: ${String(err)}`);
    return {
      ...candidate,
      title: fallbackTitle,
      modules: [],
      category: "other",
      content: candidate.sourceExcerpt,
      indexes: [],
      warnings: ["AI 结构化失败，已保留原始片段作为正文"],
    };
  }
}

function parseGeneralKnowledgeSourceId(sourceId: string): {
  sourceDocId: string;
  entrySlug: string;
} {
  const match = generalKnowledgeSourceIdRegex.exec(sourceId);
  if (!match?.[1] || !match?.[2]) {
    throw new HTTPException(400, {
      message: "Invalid general knowledge sourceId",
    });
  }
  return { sourceDocId: match[1], entrySlug: match[2] };
}

function getUserDisplayName(user: {
  realName?: string | null;
  nickname?: string | null;
  name?: string | null;
  id?: number | null;
}): string {
  return (
    user.realName?.trim() ||
    user.nickname?.trim() ||
    user.name?.trim() ||
    (user.id ? `用户 ${user.id}` : "未知用户")
  );
}

function getUserRoleLabel(role: string | null | undefined): string {
  if (role === "admin") return "管理员";
  if (role === "agent") return "客服";
  if (role === "technician") return "技术";
  if (role === "ai") return "AI";
  if (role === "customer") return "用户";
  return role || "未知角色";
}

function getFavoriteSelectionMode(messageIds: number[] | null | undefined) {
  return messageIds && messageIds.length > 0
    ? "selected_messages"
    : "entire_conversation";
}

async function loadFavoritedSourceMessages(
  db: any,
  ticketId: string,
  messageIds: number[] | null | undefined,
) {
  const rows = await db
    .select({
      id: schema.chatMessages.id,
      ticketId: schema.chatMessages.ticketId,
      senderId: schema.chatMessages.senderId,
      content: schema.chatMessages.content,
      createdAt: schema.chatMessages.createdAt,
      isInternal: schema.chatMessages.isInternal,
      withdrawn: schema.chatMessages.withdrawn,
      senderName: schema.users.name,
      senderNickname: schema.users.nickname,
      senderRealName: schema.users.realName,
      senderRole: schema.users.role,
    })
    .from(schema.chatMessages)
    .leftJoin(schema.users, eq(schema.chatMessages.senderId, schema.users.id))
    .where(
      messageIds && messageIds.length > 0
        ? and(
            eq(schema.chatMessages.ticketId, ticketId),
            inArray(schema.chatMessages.id, messageIds),
          )
        : eq(schema.chatMessages.ticketId, ticketId),
    )
    .orderBy(asc(schema.chatMessages.createdAt));

  return rows.map((row: (typeof rows)[number]) => ({
    id: row.id,
    ticketId: row.ticketId,
    senderId: row.senderId,
    senderName: getUserDisplayName({
      id: row.senderId,
      name: row.senderName,
      nickname: row.senderNickname,
      realName: row.senderRealName,
    }),
    senderRole: row.senderRole,
    senderRoleLabel: getUserRoleLabel(row.senderRole),
    createdAt: row.createdAt,
    isInternal: Boolean(row.isInternal),
    withdrawn: Boolean(row.withdrawn),
    contentText: getTextWithImageInfo(row.content as JSONContentZod),
  }));
}

const kbRouter = factory
  .createApp()
  .use(authMiddleware)
  .use(staffOnlyMiddleware())
  .post(
    "/favorited",
    describeRoute({
      tags: ["KB"],
      description:
        "Create or update favoritedConversationsKnowledge and rebuild knowledge base",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "Favorited knowledge processed successfully",
          content: {
            "application/json": {
              schema: resolver(createFavoritedResponseSchema),
            },
          },
        },
      },
    }),
    zValidator("json", createFavoritedSchema),
    async (c) => {
      const db = c.var.db;
      const { ticketId, messageIds, favoritedBy } = c.req.valid("json");
      // BUG: 需要判断并发处理，对处理中的记录不进行处理，对已经处理的进行删除重建

      // 1) 查询是否已有收藏记录
      const existed = await db.query.favoritedConversationsKnowledge.findFirst({
        where: eq(schema.favoritedConversationsKnowledge.ticketId, ticketId),
      });

      let recordId: number;

      if (!existed) {
        // 2) 创建收藏记录（首次）
        const [created] = await db
          .insert(schema.favoritedConversationsKnowledge)
          .values({
            ticketId,
            messageIds: messageIds ?? [],
            favoritedBy,
            syncStatus: "pending",
            syncedAt: null,
          })
          .returning();

        if (!created) {
          return c.json(
            {
              success: false,
              message: "Failed to create favorited knowledge",
              data: null,
            },
            500,
          );
        }

        recordId = created.id;

        emit(Events.KBFavoritesSync, created);
      } else {
        if (existed.syncStatus === "processing") {
          return c.json({
            success: true,
            message: "Favorited knowledge is already processing",
            data: { id: existed.id, syncStatus: "processing" },
          });
        }

        // 2') 已存在：先清理对应 KB，再更新记录
        await db
          .delete(schema.knowledgeBase)
          .where(
            and(
              eq(schema.knowledgeBase.sourceType, "favorited_conversation"),
              eq(schema.knowledgeBase.sourceId, ticketId),
            ),
          );

        const [updated] = await db
          .update(schema.favoritedConversationsKnowledge)
          .set({
            messageIds: messageIds ?? [],
            favoritedBy,
            syncStatus: "pending",
            syncedAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.favoritedConversationsKnowledge.ticketId, ticketId))
          .returning();

        if (!updated) {
          return c.json(
            {
              success: false,
              message: "Failed to update favorited knowledge",
              data: null,
            },
            500,
          );
        }

        recordId = updated.id;

        emit(Events.KBFavoritesSync, updated);
      }

      return c.json({
        success: true,
        message: "Favorited knowledge processed successfully",
        data: { id: recordId, syncStatus: "pending" },
      });
    },
  )
  .post(
    "/admin/general-knowledge",
    adminOnlyMiddleware(),
    describeRoute({
      tags: ["KB"],
      description: "Create or replace one general knowledge source",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "General knowledge imported successfully",
          content: {
            "application/json": {
              schema: resolver(createGeneralKnowledgeResponseSchema),
            },
          },
        },
      },
    }),
    zValidator("json", createGeneralKnowledgeSchema),
    async (c) => {
      const db = c.var.db;
      const payload = c.req.valid("json");
      const sourceId = payload.sourceId;
      const { sourceDocId, entrySlug } = parseGeneralKnowledgeSourceId(sourceId);
      const modules = normalizeStringList(payload.modules);
      const indexes = normalizeStringList(payload.indexes).slice(0, 3);
      const primaryModule = modules[0]!;
      const commonMetadata = {
        module: primaryModule,
        modules,
        category: payload.category,
        source_doc_id: sourceDocId,
        entry_slug: entrySlug,
        doc_name: payload.docName ?? "",
        revision: payload.revision,
        entry_title: payload.title,
        review_status: "approved",
        parent_chunk_id: 0,
      };
      const docs = [
        {
          chunkId: 0,
          title: payload.title,
          content: payload.content,
          metadata: {
            ...commonMetadata,
            is_summary: true,
            chunk_role: "content",
            generated_indexes: indexes,
          },
        },
        ...indexes.map((content, index) => ({
          chunkId: index + 1,
          title: `${payload.title}（召回索引）`,
          content,
          metadata: {
            ...commonMetadata,
            is_summary: false,
            chunk_role: "index",
          },
        })),
      ];

      const rows = await mapWithConcurrency(docs, 2, async (doc) => {
        const embedding = await embedEditedKnowledgeContent(doc.content);
        return {
          sourceType: "general_knowledge" as const,
          sourceId,
          chunkId: doc.chunkId,
          title: doc.title,
          content: doc.content,
          embedding,
          metadata: doc.metadata,
          contentHash: hashKnowledgeContent({
            sourceType: "general_knowledge",
            sourceId,
            chunkId: doc.chunkId,
            content: doc.content,
          }),
          score: Math.round((SOURCE_WEIGHTS.general_knowledge ?? 0.5) * 100),
        };
      });

      await db.transaction(async (tx) => {
        await tx
          .delete(schema.knowledgeBase)
          .where(
            and(
              eq(schema.knowledgeBase.sourceType, "general_knowledge"),
              eq(schema.knowledgeBase.sourceId, sourceId),
            ),
          );

        await tx.insert(schema.knowledgeBase).values(
          rows.map((row) => ({
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            chunkId: row.chunkId,
            title: row.title,
            content: row.content,
            embedding: sql`${row.embedding}::tentix.vector(3072)`,
            metadata: row.metadata,
            contentHash: row.contentHash,
            score: row.score,
          })),
        );
      });

      return c.json({
        success: true,
        data: {
          sourceType: "general_knowledge",
          sourceId,
          chunkCount: rows.length,
        },
      });
    },
  )
  .post(
    "/admin/general-knowledge/draft-from-markdown",
    adminOnlyMiddleware(),
    describeRoute({
      tags: ["KB"],
      description: "Generate in-memory general knowledge drafts from Markdown",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "General knowledge drafts generated successfully",
          content: {
            "application/json": {
              schema: resolver(createGeneralKnowledgeDraftFromMarkdownResponseSchema),
            },
          },
        },
      },
    }),
    zValidator("json", createGeneralKnowledgeDraftFromMarkdownSchema),
    async (c) => {
      const payload = c.req.valid("json");
      const allowedModules = normalizeStringList(payload.moduleOptions);
      const splitResult = splitMarkdownImportCandidates(
        payload.markdown,
        payload.maxCandidates ?? 10,
      );
      const items = await mapWithConcurrency(splitResult.candidates, 2, (candidate) =>
        structureMarkdownGeneralKnowledgeCandidate({
          candidate,
          allowedModules,
        }),
      );
      return c.json({
        success: true,
        data: {
          sourceDocId: payload.sourceDocId,
          docName: payload.docName,
          revision: payload.revision,
          totalCandidates: splitResult.totalCandidates,
          generatedCandidates: splitResult.generatedCandidates,
          skippedCandidates: splitResult.skippedCandidates,
          truncated: splitResult.truncated,
          maxCandidates: splitResult.maxCandidates,
          items,
        },
      });
    },
  )
  .get(
    "/admin/items",
    adminOnlyMiddleware(),
    describeRoute({
      tags: ["KB"],
      description: "List knowledge base sources for admin management",
      security: [{ bearerAuth: [] }],
    }),
    zValidator("query", knowledgeListQuerySchema),
    async (c) => {
      const db = c.var.db;
      const query = c.req.valid("query");
      const page = parsePositiveInt(query.page, 1, 100000);
      const pageSize = parsePositiveInt(query.pageSize, 20, 100);
      const offset = (page - 1) * pageSize;

      let failedSourceIds: string[] | undefined;
      if (query.failedOnly === "true") {
        const failedRows = await db
          .select({
            ticketId: schema.favoritedConversationsKnowledge.ticketId,
            syncedAt: schema.favoritedConversationsKnowledge.syncedAt,
            updatedAt: schema.favoritedConversationsKnowledge.updatedAt,
            title: schema.tickets.title,
            module: schema.tickets.module,
            category: schema.tickets.category,
          })
          .from(schema.favoritedConversationsKnowledge)
          .leftJoin(
            schema.tickets,
            eq(schema.favoritedConversationsKnowledge.ticketId, schema.tickets.id),
          )
          .where(eq(schema.favoritedConversationsKnowledge.syncStatus, "failed"));
        failedSourceIds = failedRows.map((row) => row.ticketId);
      }

      const whereClause = buildKnowledgeWhere(query, failedSourceIds);
      const statusHaving = buildKnowledgeStatusHaving(query.status ?? "all");
      const disabledChunkCount = sql<number>`COALESCE(SUM(CASE WHEN ${schema.knowledgeBase.isDeleted} THEN 1 ELSE 0 END), 0)`;
      let groups =
        failedSourceIds?.length === 0
          ? []
          : await db
              .select({
                sourceType: schema.knowledgeBase.sourceType,
                sourceId: schema.knowledgeBase.sourceId,
                title: sql<string>`COALESCE(MAX(NULLIF(${schema.knowledgeBase.title}, '')), '')`,
                module: sql<string | null>`MAX(${schema.knowledgeBase.metadata} ->> 'module')`,
                category: sql<string | null>`MAX(${schema.knowledgeBase.metadata} ->> 'category')`,
                chunkCount: count(),
                disabledChunkCount,
                accessCount: sql<number>`COALESCE(SUM(${schema.knowledgeBase.accessCount}), 0)`,
                isDeleted: sql<boolean>`BOOL_AND(${schema.knowledgeBase.isDeleted})`,
                updatedAt: sql<string>`MAX(${schema.knowledgeBase.updatedAt})`,
              })
              .from(schema.knowledgeBase)
              .where(whereClause)
              .groupBy(schema.knowledgeBase.sourceType, schema.knowledgeBase.sourceId)
              .having(statusHaving)
              .orderBy(sql`MAX(${schema.knowledgeBase.updatedAt}) DESC`);

      if (query.failedOnly === "true") {
        const failedFavorites = await db
          .select({
            ticketId: schema.favoritedConversationsKnowledge.ticketId,
            syncedAt: schema.favoritedConversationsKnowledge.syncedAt,
            updatedAt: schema.favoritedConversationsKnowledge.updatedAt,
            title: schema.tickets.title,
            module: schema.tickets.module,
            category: schema.tickets.category,
          })
          .from(schema.favoritedConversationsKnowledge)
          .leftJoin(
            schema.tickets,
            eq(schema.favoritedConversationsKnowledge.ticketId, schema.tickets.id),
          )
          .where(eq(schema.favoritedConversationsKnowledge.syncStatus, "failed"))
          .orderBy(sql`${schema.favoritedConversationsKnowledge.updatedAt} DESC`);
        const existingFailedSourceIds = new Set(groups.map((row) => row.sourceId));
        const keyword = query.keyword?.trim().toLowerCase();
        const sourceType = query.sourceType ?? "all";
        const module = query.module?.trim();
        const shouldShowZeroChunkFailures =
          (sourceType === "all" || sourceType === "favorited_conversation") &&
          (query.status ?? "all") === "all";
        const zeroChunkFailedGroups = shouldShowZeroChunkFailures
          ? failedFavorites
              .filter((row) => !existingFailedSourceIds.has(row.ticketId))
              .filter((row) => !module || row.module === module)
              .filter((row) => {
                if (!keyword) return true;
                return [
                  row.ticketId,
                  row.title,
                  row.module,
                  row.category,
                ].some((value) => (value ?? "").toLowerCase().includes(keyword));
              })
              .map((row) => ({
                sourceType: "favorited_conversation",
                sourceId: row.ticketId,
                title: row.title ?? row.ticketId,
                module: row.module ?? "",
                category: row.category ?? "",
                chunkCount: 0,
                disabledChunkCount: 0,
                accessCount: 0,
                isDeleted: false,
                updatedAt: row.updatedAt,
                syncFailed: true,
                syncedAt: row.syncedAt ?? null,
              }))
          : [];
        groups = [...groups, ...zeroChunkFailedGroups].sort((a, b) => {
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
      }

      const allGroups = await db
        .select({
                sourceType: schema.knowledgeBase.sourceType,
                sourceId: schema.knowledgeBase.sourceId,
                chunkCount: count(),
                disabledChunkCount,
                isDeleted: sql<boolean>`BOOL_AND(${schema.knowledgeBase.isDeleted})`,
              })
              .from(schema.knowledgeBase)
              .groupBy(schema.knowledgeBase.sourceType, schema.knowledgeBase.sourceId);

      const [failedSyncResult] = await db
        .select({ count: count() })
        .from(schema.favoritedConversationsKnowledge)
        .where(eq(schema.favoritedConversationsKnowledge.syncStatus, "failed"));

      const moduleRowsResult = await db.execute(sql`
        SELECT DISTINCT module
        FROM (
          SELECT NULLIF(metadata ->> 'module', '') AS module
          FROM tentix.knowledge_base
          WHERE NULLIF(metadata ->> 'module', '') IS NOT NULL
          UNION
          SELECT NULLIF(jsonb_array_elements_text(metadata -> 'modules'), '') AS module
          FROM tentix.knowledge_base
          WHERE jsonb_typeof(metadata -> 'modules') = 'array'
        ) modules
        WHERE module IS NOT NULL
        ORDER BY module
      `);
      const moduleRows = Array.isArray(moduleRowsResult)
        ? moduleRowsResult
        : moduleRowsResult.rows;

      const pageGroups = groups.slice(offset, offset + pageSize);
      const favoriteSourceIds = pageGroups
        .filter((row) => row.sourceType === "favorited_conversation")
        .map((row) => row.sourceId);
      const favoriteRows = favoriteSourceIds.length
        ? await db.query.favoritedConversationsKnowledge.findMany({
            where: inArray(
              schema.favoritedConversationsKnowledge.ticketId,
              favoriteSourceIds,
            ),
          })
        : [];
      const favoriteByTicketId = new Map(
        favoriteRows.map((row) => [row.ticketId, row]),
      );

      return c.json({
        items: pageGroups.map((row) => {
          const favorite = favoriteByTicketId.get(row.sourceId);
          return {
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            title: row.title || row.sourceId,
            module: row.module ?? "",
            category: row.category ?? "",
            chunkCount: Number(row.chunkCount || 0),
            disabledChunkCount: Number(row.disabledChunkCount || 0),
            accessCount: Number(row.accessCount || 0),
            isDeleted: Boolean(row.isDeleted),
            updatedAt: row.updatedAt,
            syncFailed: favorite?.syncStatus === "failed",
            syncedAt: favorite?.syncedAt ?? null,
          };
        }),
        pagination: {
          page,
          pageSize,
          total: groups.length,
          totalPages: Math.ceil(groups.length / pageSize),
        },
        summary: {
          enabledCount: allGroups.filter((row) => Number(row.disabledChunkCount || 0) < Number(row.chunkCount || 0)).length,
          disabledCount: allGroups.filter((row) => Number(row.disabledChunkCount || 0) > 0).length,
          chunkCount: allGroups.reduce((sum, row) => sum + Number(row.chunkCount || 0), 0),
          failedSyncCount: Number(failedSyncResult?.count || 0),
        },
        filters: {
          modules: moduleRows.map((row) => String(row.module)).filter(Boolean),
        },
      });
    },
  )
  .get(
    "/admin/items/:sourceType/:sourceId",
    adminOnlyMiddleware(),
    describeRoute({
      tags: ["KB"],
      description: "Get one knowledge base source with chunks",
      security: [{ bearerAuth: [] }],
    }),
    zValidator("param", knowledgeSourceParamsSchema),
    async (c) => {
      const db = c.var.db;
      const { sourceType, sourceId } = c.req.valid("param");
      const chunks = await db
        .select({
          id: schema.knowledgeBase.id,
          sourceType: schema.knowledgeBase.sourceType,
          sourceId: schema.knowledgeBase.sourceId,
          chunkId: schema.knowledgeBase.chunkId,
          title: schema.knowledgeBase.title,
          content: schema.knowledgeBase.content,
          metadata: schema.knowledgeBase.metadata,
          score: schema.knowledgeBase.score,
          accessCount: schema.knowledgeBase.accessCount,
          lang: schema.knowledgeBase.lang,
          tokenCount: schema.knowledgeBase.tokenCount,
          isDeleted: schema.knowledgeBase.isDeleted,
          createdAt: schema.knowledgeBase.createdAt,
          updatedAt: schema.knowledgeBase.updatedAt,
        })
        .from(schema.knowledgeBase)
        .where(
          and(
            eq(schema.knowledgeBase.sourceType, sourceType),
            eq(schema.knowledgeBase.sourceId, sourceId),
          ),
        )
        .orderBy(schema.knowledgeBase.chunkId);

      const favorite =
        sourceType === "favorited_conversation"
          ? await db.query.favoritedConversationsKnowledge.findFirst({
              where: eq(schema.favoritedConversationsKnowledge.ticketId, sourceId),
            })
          : null;
      const sourceMessages =
        favorite && favorite.syncStatus === "failed"
          ? await loadFavoritedSourceMessages(db, sourceId, favorite.messageIds)
          : [];
      const ticket =
        sourceType === "favorited_conversation" && favorite
          ? await db.query.tickets.findFirst({
              where: eq(schema.tickets.id, sourceId),
            })
          : null;

      if (chunks.length === 0) {
        if (!favorite || favorite.syncStatus !== "failed") {
          throw new HTTPException(404, { message: "Knowledge item not found" });
        }
        return c.json({
          sourceType,
          sourceId,
          title: ticket?.title || sourceId,
          module: ticket?.module ?? "",
          category: ticket?.category ?? "",
          area: ticket?.area ?? "",
          tags: [],
          problemSummary: "",
          isDeleted: false,
          accessCount: 0,
          syncFailed: true,
          syncedAt: favorite.syncedAt ?? null,
          ticketId: favorite.ticketId,
          selectionMode: getFavoriteSelectionMode(favorite.messageIds),
          sourceMessages,
          createdAt: favorite.createdAt,
          updatedAt: favorite.updatedAt,
          chunks: [],
        });
      }

      const firstChunk = chunks.find((chunk) => Number(chunk.chunkId) === 0) ?? chunks[0]!;

      return c.json({
        sourceType,
        sourceId,
        title: firstChunk.title || sourceId,
        module: getMetadataString(firstChunk.metadata, "module"),
        category: getMetadataString(firstChunk.metadata, "category"),
        area: getMetadataString(firstChunk.metadata, "area"),
        tags: getMetadataStringArray(firstChunk.metadata, "tags"),
        problemSummary: getMetadataString(firstChunk.metadata, "problem_summary"),
        isDeleted: chunks.every((chunk) => Boolean(chunk.isDeleted)),
        accessCount: chunks.reduce((sum, chunk) => sum + Number(chunk.accessCount || 0), 0),
        syncFailed: favorite?.syncStatus === "failed",
        syncedAt: favorite?.syncedAt ?? null,
        ticketId: favorite?.ticketId ?? null,
        selectionMode: favorite ? getFavoriteSelectionMode(favorite.messageIds) : null,
        sourceMessages,
        createdAt: firstChunk.createdAt,
        updatedAt: firstChunk.updatedAt,
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          chunkId: Number(chunk.chunkId),
          title: chunk.title,
          content: chunk.content,
          metadata: chunk.metadata,
          score: Number(chunk.score || 0),
          accessCount: Number(chunk.accessCount || 0),
          lang: chunk.lang,
          tokenCount: Number(chunk.tokenCount || 0),
          isDeleted: Boolean(chunk.isDeleted),
          createdAt: chunk.createdAt,
          updatedAt: chunk.updatedAt,
        })),
      });
    },
  )
  .patch(
    "/admin/items/:sourceType/:sourceId",
    adminOnlyMiddleware(),
    describeRoute({
      tags: ["KB"],
      description: "Update knowledge title, status, chunks, and rebuilt metadata",
      security: [{ bearerAuth: [] }],
    }),
    zValidator("param", knowledgeSourceParamsSchema),
    zValidator("json", knowledgeUpdateSchema),
    async (c) => {
      const db = c.var.db;
      const { sourceType, sourceId } = c.req.valid("param");
      const payload = c.req.valid("json");
      if (sourceType === "general_knowledge") {
        throw new HTTPException(400, {
          message: "General knowledge updates should use the import endpoint",
        });
      }
      const existing = await db
        .select()
        .from(schema.knowledgeBase)
        .where(
          and(
            eq(schema.knowledgeBase.sourceType, sourceType),
            eq(schema.knowledgeBase.sourceId, sourceId),
          ),
        )
        .orderBy(schema.knowledgeBase.chunkId);

      if (existing.length === 0) {
        throw new HTTPException(404, { message: "Knowledge item not found" });
      }

      const existingById = new Map(existing.map((row) => [row.id, row]));
      const changedContentById = new Map<string, string>();
      for (const chunk of payload.chunks ?? []) {
        const row = existingById.get(chunk.id);
        if (!row) {
          throw new HTTPException(400, { message: "Invalid knowledge chunk" });
        }
        changedContentById.set(chunk.id, chunk.content);
      }

      const rebuiltById = new Map<string, Awaited<ReturnType<typeof rebuildEditedKnowledgeMetadata>>>();
      const changedEmbeddingById = new Map<string, string>();
      const changedEntries = Array.from(changedContentById.entries());

      if (changedEntries.length > 0) {
        try {
          const firstChangedRow = existingById.get(changedEntries[0]![0])!;
          const firstMetadata =
            firstChangedRow.metadata && typeof firstChangedRow.metadata === "object"
              ? (firstChangedRow.metadata as Record<string, unknown>)
              : {};
          const sourceContext = await loadEditedKnowledgeSourceContext({
            db,
            sourceType,
            sourceId,
            metadata: firstMetadata,
          });
          const rebuiltChunks = await mapWithConcurrency(
            changedEntries,
            2,
            async ([id, content]) => {
              const row = existingById.get(id)!;
              const metadata =
                row.metadata && typeof row.metadata === "object"
                  ? (row.metadata as Record<string, unknown>)
                  : {};
              const rebuilt = await rebuildEditedKnowledgeMetadata({
                db,
                sourceType,
                sourceId,
                title: row.title || sourceId,
                metadata,
                chunks: [{ chunkId: Number(row.chunkId), content }],
                sourceContext,
              });
              const embedding = await embedEditedKnowledgeContent(content);
              return { id, rebuilt, embedding };
            },
          );
          for (const { id, rebuilt, embedding } of rebuiltChunks) {
            rebuiltById.set(id, rebuilt);
            changedEmbeddingById.set(id, embedding);
          }
        } catch (err) {
          logWarning(`[kb.admin.rebuildChunk] failed source=${sourceType}:${sourceId}: ${String(err)}`);
          throw new HTTPException(502, {
            message: "Failed to rebuild knowledge chunk",
          });
        }
      }

      await db.transaction(async (tx) => {
        for (const [id, content] of changedContentById) {
          const row = existingById.get(id)!;
          const rebuilt = rebuiltById.get(id)!;
          const metadata =
            row.metadata && typeof row.metadata === "object"
              ? (row.metadata as Record<string, unknown>)
              : {};
          await tx
            .update(schema.knowledgeBase)
            .set({
              content,
              metadata: {
                ...metadata,
                problem_summary: rebuilt.metadata.problem_summary,
                solution_steps: rebuilt.metadata.solution_steps,
                generated_queries: rebuilt.metadata.generated_queries,
                tags: rebuilt.metadata.tags,
              },
              embedding: sql`${changedEmbeddingById.get(id)}::tentix.vector(3072)`,
              contentHash: hashKnowledgeContent({
                sourceType,
                sourceId,
                chunkId: Number(row.chunkId),
                content,
              }),
              updatedAt: sql`NOW()`,
            })
            .where(eq(schema.knowledgeBase.id, id));
        }
      });

      return c.json({ success: true });
    },
  )
  .patch(
    "/admin/chunks/:id",
    adminOnlyMiddleware(),
    zValidator("param", knowledgeChunkParamsSchema),
    zValidator("json", knowledgeChunkUpdateSchema),
    async (c) => {
      const db = c.var.db;
      const { id } = c.req.valid("param");
      const payload = c.req.valid("json");
      const [updated] = await db
        .update(schema.knowledgeBase)
        .set({
          isDeleted: payload.isDeleted,
          updatedAt: sql`NOW()`,
        })
        .where(eq(schema.knowledgeBase.id, id))
        .returning({ id: schema.knowledgeBase.id });
      if (!updated) throw new HTTPException(404, { message: "Knowledge chunk not found" });
      return c.json({ success: true });
    },
  )
  .delete(
    "/admin/items/:sourceType/:sourceId",
    adminOnlyMiddleware(),
    describeRoute({
      tags: ["KB"],
      description: "Delete knowledge source and its chunks",
      security: [{ bearerAuth: [] }],
    }),
    zValidator("param", knowledgeSourceParamsSchema),
    async (c) => {
      const db = c.var.db;
      const { sourceType, sourceId } = c.req.valid("param");
      await db.transaction(async (tx) => {
        await tx
          .delete(schema.knowledgeBase)
          .where(
            and(
              eq(schema.knowledgeBase.sourceType, sourceType),
              eq(schema.knowledgeBase.sourceId, sourceId),
            ),
          );

        if (sourceType === "favorited_conversation") {
          await tx
            .delete(schema.favoritedConversationsKnowledge)
            .where(eq(schema.favoritedConversationsKnowledge.ticketId, sourceId));
        }
      });

      return c.json({ success: true });
    },
  );

export { kbRouter };
