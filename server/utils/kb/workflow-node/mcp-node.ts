import { WorkflowState, getVariables } from "./workflow-tools";
import { DEFAULT_API_KEY, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./workflow-tools";
import { type McpConfig } from "@/utils/const";
import { logError } from "@/utils/log";
import { tickets } from "@/db/schema";
import { connectDB } from "@/utils/tools";
import { eq } from "drizzle-orm";
import { renderTemplate as renderLiquidTemplate } from "@/utils/template";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const apiSelectionSchema = z.object({
  selectedApiId: z.string().min(1),
  reason: z.string().default(""),
});


type McpVars = {
  status: "stub" | "disabled" | "error"| "success";
  reason: string;
  result?: unknown;
  updatedAt: string;
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function toShortString(x: unknown, maxLen: number): string {
  const s = typeof x === "string" ? x : String(x ?? "");
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function toNonEmptyTrimmed(x: unknown): string | null {
  const s = typeof x === "string" ? x.trim() : String(x ?? "").trim();
  return s.length > 0 ? s : null;
}

async function getZoneNsByTicketId(ticketId: string): Promise<{
  zone: string | null;
  namespace: string | null;
}> {
  const db = connectDB();
  const [row] = await db
    .select({
      zone: tickets.area,
      namespace: tickets.sealosNamespace,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  return {
    zone: toNonEmptyTrimmed(row?.zone),
    namespace: toNonEmptyTrimmed(row?.namespace),
  };
}

/**
 * MCP 节点（最小可运行 stub）
 *
 * 目标：
 * - 无论是否启用，都写入 variables.mcp.status / reason（以及 result/updatedAt）
 * - 先不实现真正的 MCP 调用逻辑，留 TODO 占位
 */
export async function mcpNode(
  state: WorkflowState,
  config: McpConfig["config"],
): Promise<Partial<WorkflowState>> {
  const variables = getVariables(state);
  const lastCustomerMessage = toShortString(variables.lastCustomerMessage, 200);

  // 注意：前端新建节点可能没有 config（或为空对象），这里按“默认启用”处理
  const enabled = (config as any)?.enabled !== false;

  // 取旧 mcp（避免浅合并时覆盖掉未来你可能加的字段）
  const prevMcpRaw = (state.variables ?? {})["mcp"];
  const prevMcp = isPlainObject(prevMcpRaw) ? prevMcpRaw : {};

  const now = new Date().toISOString();

  try {
    if (!enabled) {
      const nextMcp: McpVars & Record<string, unknown> = {
        ...prevMcp,
        status: "disabled",
        reason: "mcp node disabled by config.enabled=false",
        // result 先保留旧值（若无则置 null，方便模板调试）
        result: "result" in prevMcp ? prevMcp.result : null,
        updatedAt: now,
      };

      return { variables: { mcp: nextMcp } };
    }

    // TODO(MCP): 这里将来接入真正的 MCP 调用
    //
    // 你未来大概率会做的事：
    // - 组装请求参数（可能基于 variables / state.currentTicket / state.messages）
    // - 发起 fetch 或调用 MCP SDK
    // - 把结果写到 variables.mcp.result
    //
    // 例如（伪代码）：
    // const result = await fetchMcpTool({ tool: "...", input: {...} });

    const ticketId = variables.currentTicket?.id;
    if (!ticketId) {
      const nextMcp: McpVars & Record<string, unknown> = {
        ...prevMcp,
        status: "error",
        reason: "missing currentTicket.id",
        result: null,
        updatedAt: now,
      };
      return { variables: { mcp: nextMcp } };
    }
    
    const { zone, namespace } = await getZoneNsByTicketId(ticketId);
    
    if (!zone || !namespace) {
      const missing: string[] = [];
      if (!zone) missing.push("tickets.area");
      if (!namespace) missing.push("tickets.sealosNamespace");
    
      const nextMcp: McpVars & Record<string, unknown> = {
        ...prevMcp,
        status: "error",
        ticketId,
        zone: zone ?? undefined,
        namespace: namespace ?? undefined,
        source: "tickets",
        reason: `missing ${missing.join(", ")}`,
        result: null,
        updatedAt: now,
      };
      return { variables: { mcp: nextMcp } };
    }
// 1) 读取 MCP 节点配置（全部允许为 undefined）
const baseUrl = toNonEmptyTrimmed((config as any)?.baseUrl);
const apis = (config as any)?.apis as
  | Array<{ id: string; name: string; method: "GET" | "POST"; path: string }>
  | undefined;
const selectedApiId = toNonEmptyTrimmed((config as any)?.selectedApiId);
const enableAiSelection = (config as any)?.enableAiSelection === true;
const aiSystemPromptTpl = (config as any)?.systemPrompt as string | undefined;
const aiUserPromptTpl = (config as any)?.userPrompt as string | undefined;


if (!baseUrl) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        reason: "missing config.baseUrl",
        result: null,
        updatedAt: now,
      },
    },
  };
}

if (!Array.isArray(apis) || apis.length === 0) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        reason: "missing config.apis (empty)",
        result: null,
        updatedAt: now,
      },
    },
  };
}

// [新增/替换] AI 选择核心逻辑开始
const manualSelectedApiId = selectedApiId; // 复用上方已读取的配置
let finalSelectedApiId: string | null = manualSelectedApiId;
let aiSelectedApiId: string | null = null;
let aiReason: string | null = null;

if (enableAiSelection) {
  // 1) 渲染 AI 选择 prompt
  const promptVars = {
    ...variables,
    zone,
    namespace,
    apis,
  };

// 检查用户是否填写了 prompt
if (!aiSystemPromptTpl || !aiUserPromptTpl) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        reason: "enableAiSelection=true but systemPrompt or userPrompt is empty",
        result: null,
        updatedAt: now,
      },
    },
  };
}

const systemPrompt = await renderLiquidTemplate(
  aiSystemPromptTpl,
  promptVars,
);
const userPrompt = await renderLiquidTemplate(
  aiUserPromptTpl,
  promptVars,
);

  // 2) 调 LLM
  try {
    const chat = new ChatOpenAI({
      apiKey: (config as any)?.llm?.apiKey || DEFAULT_API_KEY,
      model: (config as any)?.llm?.model || DEFAULT_MODEL,
      configuration: {
        baseURL: (config as any)?.llm?.baseURL || DEFAULT_BASE_URL,
      },
    });

    const out = await chat
      .withStructuredOutput(apiSelectionSchema)
      .invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

    aiSelectedApiId = toNonEmptyTrimmed(out.selectedApiId);
    aiReason = toNonEmptyTrimmed(out.reason);

    // 3) 白名单校验
    if (aiSelectedApiId && apis.some((a) => a?.id === aiSelectedApiId)) {
      finalSelectedApiId = aiSelectedApiId;
    } else {
      finalSelectedApiId = null; // AI 选了不存在的 ID
    }
  } catch (e) {
    aiSelectedApiId = null;
    aiReason = `ai selection failed: ${toShortString((e as any)?.message ?? e, 200)}`;
    finalSelectedApiId = null;
  }

  // 4) 兜底策略
  if (!finalSelectedApiId) {
    const noneApi = apis.find(
      (a) => (a?.name ?? "").trim().toLowerCase() === "none",
    );
    // 优先级：AI合法值 > none接口 > 手动选择值 > 第一个接口 > null
    finalSelectedApiId =
      noneApi?.id ?? manualSelectedApiId ?? apis[0]?.id ?? null;

    if (!finalSelectedApiId) {
      return {
        variables: {
          mcp: {
            ...prevMcp,
            status: "error",
            ticketId,
            zone,
            namespace,
            source: "tickets",
            aiSelectedApiId,
            aiReason,
            reason: "no api available for fallback",
            result: null,
            updatedAt: now,
          },
        },
      };
    }
  }
} else {
  // 未开启 AI，必须有手动选择的 ID
  if (!finalSelectedApiId) {
    return {
      variables: {
        mcp: {
          ...prevMcp,
          status: "error",
          ticketId,
          zone,
          namespace,
          source: "tickets",
          reason: "missing config.selectedApiId",
          result: null,
          updatedAt: now,
        },
      },
    };
  }
}

// [关键修改] 使用计算出的 finalSelectedApiId 来查找接口
const api = apis.find((a) => a && a.id === finalSelectedApiId);
// [新增/替换] AI 选择核心逻辑结束
if (!api) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        reason: `selectedApiId not found in apis: ${selectedApiId}`,
        result: null,
        updatedAt: now,
      },
    },
  };
}

const method = api.method;
const path = toNonEmptyTrimmed(api.path);
if (!path) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        apiId: api.id,
        reason: "api.path is empty",
        result: null,
        updatedAt: now,
      },
    },
  };
}

// MVP：先只允许 GET
if (method !== "GET") {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        apiId: api.id,
        reason: `method ${method} not supported in MVP (only GET)`,
        result: null,
        updatedAt: now,
      },
    },
  };
}

// 2) 拼 URL：baseUrl + path，并附带 query zone/namespace
let url: URL;
try {
  url = new URL(path, baseUrl);
  url.searchParams.set("zone", zone);
  url.searchParams.set("namespace", namespace);
} catch (e) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        apiId: api.id,
        reason: `invalid url: baseUrl=${baseUrl} path=${path}`,
        result: null,
        updatedAt: now,
      },
    },
  };
}

// 3) 执行 fetch（MVP：读取 text 并写入 mcp.result，保证 {{ mcp.result }} 可见）
let resp: Response;
try {
  resp = await fetch(url.toString(), { method: "GET" });
} catch (e) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        apiId: api.id,
        requestUrl: url.toString(),
        reason: `fetch failed: ${toShortString((e as any)?.message ?? e, 300)}`,
        result: null,
        updatedAt: now,
      },
    },
  };
}

const bodyText = await resp.text();

if (!resp.ok) {
  return {
    variables: {
      mcp: {
        ...prevMcp,
        status: "error",
        ticketId,
        zone,
        namespace,
        source: "tickets",
        apiId: api.id,
        requestUrl: url.toString(),
        reason: `http ${resp.status} ${resp.statusText}: ${toShortString(bodyText, 500)}`,
        result: bodyText,
        updatedAt: now,
      },
    },
  };
}

// 4) 成功：把结果写入 variables.mcp.result
// 注意：这里 result 写 string，保证 {{ mcp.result }} 直接可读
const resultText = bodyText;
    const nextMcp: McpVars & Record<string, unknown> = {
      ...prevMcp,
      status: "success",
      ticketId,
      zone,
      namespace,
      source: "tickets",
      aiSelectedApiId,
      aiReason,
      finalSelectedApiId,
      apiId: api.id,
      apiName: api.name,
      apiMethod: method,
      apiPath: path,
      requestUrl: url.toString(),
      reason: `fetch ok (${api.name})`,
      result: resultText,       
      updatedAt: now,
    };
    
    return { variables: { mcp: nextMcp } };
  } catch (err) {
    logError("mcpNode", err);
    const nextMcp: McpVars & Record<string, unknown> = {
      ...prevMcp,
      status: "error",
      reason: `mcp node failed: ${toShortString((err as any)?.message ?? err, 300)}`,
      result: null,
      updatedAt: now,
    };
    return { variables: { mcp: nextMcp } };
  }
}