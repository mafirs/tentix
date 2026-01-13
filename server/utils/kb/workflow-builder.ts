// ============================================================================
// 【快速上手区】
// ============================================================================
/*
【文件作用】
将 DB 中的 workflow 配置（nodes/edges 的 JSON）编译成 LangGraph StateGraph 对象
核心痛点：workflow 定义是 JSON 配置，需要转换成可执行的 LangGraph 对象
输入：WorkflowConfig（包含 nodes 数组和 edges 数组）
输出：CompiledStateGraph（可 invoke/stream 的 LangGraph 对象）

【核心入口函数】
1. new WorkflowBuilder(config) - 构造函数，接收 workflow 配置
2. builder.build() - 编译 workflow，返回 CompiledStateGraph

【关键数据对象】
1. WorkflowConfig: workflow 配置对象（来自 DB workflow 表）
   → nodes: 节点数组（START/END/SMART_CHAT/EMOTION_DETECTOR/HANDOFF/ESCALATION_OFFER/RAG）
   → edges: 边数组（source + target + condition（可选））
   → 证据：@/utils/const.ts 的 WorkflowConfig 类型定义

2. nodeMap: Map<nodeId, NodeConfig>
   → 节点 ID 到节点配置的映射（O(1) 查找）
   → 证据：第 34-41 行的 Map 定义，第 48-50 行的构建逻辑

3. StateGraph: LangGraph 的状态图类
   → 包含节点（addNode）和边（addEdge/addConditionalEdges）
   → 证据：@langchain/langgraph 的 StateGraph 类

【主要副作用】
- 日志：logError 记录孤岛节点、不可达 END 节点、条件评估失败
- 编译：graph.compile() 生成 CompiledStateGraph（无 IO/DB/网络操作）
- 错误：抛出 Error（无 START 节点、多个 START 节点、无 END 节点、END 不可达）

【改动导航】
想改 "X"？优先看这里：
  1. 添加新的节点类型 → 第 256-280 行（executeNode 方法：switch 分支添加新 case）
  2. 修改边的规则（如允许多条 START 边） → 第 125-138 行（START 节点的边构建逻辑）
  3. 修改条件评估逻辑（如支持更复杂的表达式） → 第 283-299 行（evaluateCondition 函数）
  4. 修改孤岛节点检测逻辑 → 第 58-68 行（unreachableNodes 过滤和日志）
*/
// ============================================================================

import {
  EmotionDetectionConfig,
  HandoffConfig,
  EscalationOfferConfig,
  SmartChatConfig,
  WorkflowEdge,
  WorkflowConfig,
  BaseNodeConfig,
  RagConfig,
  NodeType,
  McpConfig,
} from "@/utils/const";
import {
  WorkflowState,
  WorkflowStateAnnotation,
  emotionDetectionNode,
  handoffNode,
  escalationOfferNode,
  chatNode,
  ragNode,
  getVariables,
  mcpNode,
} from "./workflow-node";

import {
  StateGraph,
  END,
  type CompiledStateGraph,
  START,
} from "@langchain/langgraph";

import { logError } from "@/utils/log.ts";

/**
 * ============================================================================
 * 【类名】WorkflowBuilder - LangGraph 工作流编译器
 * ============================================================================
 *
 * 【用途】
 * 将 workflow JSON 配置编译成 LangGraph StateGraph 对象
 * 核心痛点：workflow 存储在 DB 中是 JSON 格式，需要转换成可执行的 LangGraph 对象
 *
 * 【调用关系】
 * - 上游：WorkflowCache.initialize() 调用 new WorkflowBuilder(workflow).build()
 * - 下游：executeNode() 调用具体的节点实现（emotionDetectionNode/chatNode 等）
 *
 * 【核心流程】
 * 1) 构造函数：建立 nodeMap（nodeId -> NodeConfig 映射）
 * 2) build(): 找出可达节点 → 添加节点 → 添加边 → 编译返回
 * 3) findReachableNodes(): BFS 遍历，找出从 START 可达的所有节点
 * 4) executeNode(): 根据 node.type 调用对应的节点函数
 * 5) evaluateCondition(): 动态评估条件表达式（字符串转布尔值）
 *
 * 【错误与边界】
 * - 无 START 节点：抛出 Error（第 383-384 行）
 * - 多个 START 节点：抛出 Error（第 386-390 行）
 * - 无 END 节点：抛出 Error（第 396-397 行）
 * - END 节点不可达：抛出 Error（第 432-435 行）
 * - START 有多条边或有条件边：抛出 Error（第 291-293 行）
 * - 条件评估失败：返回 false（第 575 行），走默认边
 */
export class WorkflowBuilder {
  // workflow 配置（来自 DB）
  // 证据：WorkflowConfig 类型定义包含 nodes 和 edges 数组
  private config: WorkflowConfig;

  // 节点 ID 到节点配置的映射
  // 为什么用 Map：O(1) 查找，比 Array.find() 快
  // 证据：第 162-163 行的构建逻辑
  private nodeMap: Map<
    string,
    | EmotionDetectionConfig
    | HandoffConfig
    | EscalationOfferConfig
    | SmartChatConfig
    | BaseNodeConfig
  >;

  /**
   * ============================================================================
   * 【方法】constructor() - 构造函数：初始化 nodeMap
   * ============================================================================
   *
   * 【用途】
   * 接收 workflow 配置，建立 nodeMap（nodeId -> NodeConfig 映射）
   * 上游：WorkflowCache.initialize() 调用 new WorkflowBuilder(workflow)
   *
   * 【核心流程】
   * 1) 保存 config 到实例变量
   * 2) 遍历 config.nodes，建立 nodeMap（nodeId -> NodeConfig）
   *
   * 【参数说明】
   * @param config - workflow 配置对象
   *   → 通常来自 DB 查询结果（workflow 表）
   *   → 最小字段示例：{id: "wf-123", name: "客服工作流", nodes: [...], edges: [...]}
   *
   * 【数据快照】
   * 入参示例（来自 schema）：
   *   {
   *     id: "wf-123",
   *     name: "客服工作流",
   *     nodes: [
   *       {id: "start", type: "START"},
   *       {id: "chat", type: "SMART_CHAT", config: {...}},
   *       {id: "end", type: "END"}
   *     ],
   *     edges: [
   *       {source: "start", target: "chat"},
   *       {source: "chat", target: "end"}
   *     ]
   *   }
   *
   * 【错误与边界】
   * - 无错误：构造函数不验证配置，验证在 build() 中进行
   */
  constructor(config: WorkflowConfig) {
    this.config = config;
    this.nodeMap = new Map();

    // 翻译：for (const node of config.nodes) 遍历所有节点
    // 目的：建立 nodeMap，后续可以通过 nodeId 快速查找节点配置
    for (const node of config.nodes) {
      this.nodeMap.set(node.id, node);
    }
  }

  /**
   * ============================================================================
   * 【方法】build() - 编译 workflow：返回 CompiledStateGraph
   * ============================================================================
   *
   * 【用途】
   * 将 workflow JSON 配置编译成 LangGraph StateGraph 对象
   * 上游：WorkflowCache.initialize() 调用 builder.build()
   * 下游：LangGraph 的 invoke()/stream() 方法调用编译后的 workflow
   *
   * 【核心流程】
   * 1) 找出所有可达节点（从 START 可达的节点）
   * 2) 警告孤岛节点（不可达的节点）
   * 3) 添加可达的节点到 graph（addNode）
   * 4) 添加边到 graph（addEdge/addConditionalEdges）
   * 5) 编译返回（graph.compile()）
   *
   * 【数据快照】
   * 返回值：CompiledStateGraph<WorkflowState, Partial<WorkflowState>>
   *   → LangGraph 编译后的状态图对象
   *   → 可调用 invoke(state)/stream(state) 执行工作流
   *
   * 【错误与边界】
   * - START 节点有多条边或有条件边：抛出 Error（第 291-293 行）
   * - 条件评估失败：logError，返回 false（不走条件边）
   * - 孤岛节点：logError，但不影响编译（第 208-211 行）
   */
  build() {
    // 1) 找出所有可达节点（从 START 可达的节点）
    // 为什么：只编译可达的节点，孤岛节点不执行（避免浪费资源）
    const reachableNodes = this.findReachableNodes();

    // 2) 找出孤岛节点并记录日志
    // 翻译：filter() 过滤出不可达的节点（排除 START 和 END）
    // 目的：警告用户有节点不会被执行（可能是配置错误）
    const unreachableNodes = this.config.nodes.filter(
      (node) =>
        !reachableNodes.has(node.id) &&
        node.type !== NodeType.START &&
        node.type !== NodeType.END,
    );
    if (unreachableNodes.length > 0) {
      logError(
        `工作流 ${this.config.name} 中发现 ${unreachableNodes.length} 个孤岛节点（不可达节点）：${unreachableNodes.map((n) => n.id).join(", ")}`,
      );
    }

    // 3) 创建 StateGraph 对象
    // 证据：WorkflowStateAnnotation 定义了 WorkflowState 的结构
    let graph: any = new StateGraph(WorkflowStateAnnotation);

    // 4) 只添加可达的节点
    // 为什么跳过 START 和 END：LangGraph 内部处理这两个特殊节点
    for (const node of this.config.nodes) {
      if (node.type === NodeType.START || node.type === NodeType.END) {
        continue;
      }

      // 跳过不可达的节点
      if (!reachableNodes.has(node.id)) {
        continue;
      }

      // 翻译：graph.addNode(nodeId, async (state) => {...}) 添加节点到 graph
      // 目的：定义节点的执行逻辑（调用 executeNode 方法）
      graph = graph.addNode(node.id, async (state: WorkflowState) => {
        return await this.executeNode(
          node as
            | EmotionDetectionConfig
            | HandoffConfig
            | EscalationOfferConfig
            | SmartChatConfig,
          state,
        );
      });
    }

    // 5) 构建边的映射（只包含可达节点的边）
    // 为什么用 Map：快速查找某个节点的所有出边
    const edgeMap = new Map<string, WorkflowEdge[]>();
    for (const edge of this.config.edges) {
      // 只添加源和目标都可达的边
      const sourceNode = this.nodeMap.get(edge.source);
      const targetNode = this.nodeMap.get(edge.target);

      // 翻译：?? 是空值合并操作符，左侧为 null/undefined 时返回右侧
      // 逻辑：START 节点或可达节点才算 sourceReachable
      const sourceReachable =
        sourceNode?.type === NodeType.START || reachableNodes.has(edge.source);
      const targetReachable =
        targetNode?.type === NodeType.END || reachableNodes.has(edge.target);

      if (!sourceReachable || !targetReachable) {
        continue;
      }

      const edges = edgeMap.get(edge.source) || [];
      edges.push(edge);
      edgeMap.set(edge.source, edges);
    }

    // 6) 添加边
    // 遍历 edgeMap，为每个源节点添加边
    for (const [sourceId, edges] of edgeMap.entries()) {
      if (edges.length === 0) {
        continue;
      }

      const sourceNode = this.nodeMap.get(sourceId);
      const isStartNode = sourceNode?.type === NodeType.START;

      if (isStartNode) {
        const firstEdge = edges[0];
        // 规则：START 仅允许一条无条件边
        // 为什么：START 是入口点，只能有一条路径（避免歧义）
        if (edges.length === 1 && firstEdge && !firstEdge.condition) {
          const targetNode = this.nodeMap.get(firstEdge.target);
          // 翻译：targetNode?.type === NodeType.END ? END : firstEdge.target
          // 意思：如果是 END 节点，用 LangGraph 的 END 常量；否则用节点 ID
          const target =
            targetNode?.type === NodeType.END ? END : firstEdge.target;
          graph.addEdge(START, target as any);
          continue;
        }
        throw new Error(
          `Invalid workflow: START must have exactly one unconditional edge, got ${edges.length} edge(s) with condition count ${edges.filter((e) => e.condition).length}`,
        );
      }

      // 非 START 源
      const firstEdge = edges[0];
      if (edges.length === 1 && firstEdge && !firstEdge.condition) {
        // 7) 简单边（单一无条件边）
        // 为什么：单一边可以直接用 addEdge（条件边需要 addConditionalEdges）
        const targetNode = this.nodeMap.get(firstEdge.target);
        const target =
          targetNode?.type === NodeType.END ? END : firstEdge.target;
        graph.addEdge(sourceId as any, target as any);
      } else {
        // 8) 条件边（多条边或有条件的边）
        // 为什么：需要根据条件动态选择路径
        const conditions = edges
          .filter((e) => !!e.condition)
          .map((e) => ({ edge: e, cond: e.condition as string }));
        const defaultEdge = edges.find((e) => !e.condition);

        // 翻译：graph.addConditionalEdges(sourceId, (state) => {...})
        // 意思：添加条件边，返回目标节点 ID（根据条件判断）
        graph.addConditionalEdges(sourceId as any, (state: WorkflowState) => {
          const variables = getVariables(state);

          // 检查条件边（按顺序遍历）
          // 为什么按顺序：可能存在多个条件都满足，优先匹配第一个
          for (const item of conditions) {
            if (evaluateCondition(item.cond, variables)) {
              const targetNode = this.nodeMap.get(item.edge.target);
              return targetNode?.type === NodeType.END ? END : item.edge.target;
            }
          }

          // 默认边（无条件边）
          if (defaultEdge) {
            const targetNode = this.nodeMap.get(defaultEdge.target);
            return targetNode?.type === NodeType.END ? END : defaultEdge.target;
          }

          return END;
        });
      }
    }

    // 9) 编译返回
    // 证据：LangGraph 的 StateGraph.compile() 方法返回 CompiledStateGraph
    return graph.compile() as CompiledStateGraph<
      WorkflowState,
      Partial<WorkflowState>
    >;
  }

  /**
   * ============================================================================
   * 【方法】findReachableNodes() - 使用 BFS 找出所有可达节点
   * ============================================================================
   *
   * 【用途】
   * 使用 BFS 算法找出从 START 节点可达的所有节点
   * 上游：build() 方法调用此方法过滤孤岛节点
   *
   * 【核心流程】
   * 1) 验证 START 节点：必须有且只能有一个
   * 2) 验证 END 节点：至少要有一个
   * 3) BFS 遍历：从 START 开始，沿着边遍历所有可达节点
   * 4) 验证 END 可达：至少有一个 END 节点可达
   * 5) 警告不可达的 END 节点
   *
   * 【数据快照】
   * 返回值：Set<string>
   *   → 包含所有可达节点的 ID（包括 START 和可达的 END）
   *   → 示例：Set{"start", "emotion", "chat", "end"}
   *
   * 【错误与边界】
   * - 无 START 节点：抛出 Error（第 383-384 行）
   * - 多个 START 节点：抛出 Error（第 386-390 行）
   * - 无 END 节点：抛出 Error（第 396-397 行）
   * - END 节点不可达：抛出 Error（第 432-435 行）
   * - 不可达的 END 节点：logError（第 440-443 行）
   */
  private findReachableNodes(): Set<string> {
    const reachable = new Set<string>();
    const queue: string[] = [];

    // 1) 验证 START 节点：必须有且只能有一个
    // 为什么：workflow 需要唯一的入口点
    const startNodes = this.config.nodes.filter(
      (n) => n.type === NodeType.START,
    );
    if (startNodes.length === 0) {
      throw new Error("工作流中未找到 START 节点");
    }
    if (startNodes.length > 1) {
      throw new Error(
        `工作流中有 ${startNodes.length} 个 START 节点，只能有一个 START 节点：${startNodes.map((n) => n.id).join(", ")}`,
      );
    }
    const startNode = startNodes[0]!; // 翻译：! 是非空断言，已验证 length > 0，安全使用

    // 2) 验证 END 节点：至少要有一个（可以有多个）
    // 为什么：workflow 需要至少一个出口点
    const endNodes = this.config.nodes.filter((n) => n.type === NodeType.END);
    if (endNodes.length === 0) {
      throw new Error("工作流中未找到 END 节点");
    }

    // 3) BFS 初始化：将 START 节点加入队列
    // 翻译：queue.push() 将元素添加到数组末尾（队列尾部）
    queue.push(startNode.id);
    reachable.add(startNode.id);

    // 4) BFS 遍历所有可达节点
    // 翻译：while (queue.length > 0) 当队列不为空时继续遍历
    // 翻译：queue.shift() 移除并返回队列第一个元素（队列头部）
    while (queue.length > 0) {
      const currentId = queue.shift()!;

      // 找到所有从 currentId 出发的边
      const outgoingEdges = this.config.edges.filter(
        (e) => e.source === currentId,
      );

      for (const edge of outgoingEdges) {
        if (!reachable.has(edge.target)) {
          reachable.add(edge.target);
          const targetNode = this.nodeMap.get(edge.target);
          // END 节点不需要继续遍历
          // 为什么：END 是出口点，不会有出边
          if (targetNode?.type !== NodeType.END) {
            queue.push(edge.target);
          }
        }
      }
    }

    // 5) 验证至少有一个 END 节点可达
    // 为什么：如果 END 不可达，workflow 无法正常结束
    const reachableEndNodes = endNodes.filter((n) => reachable.has(n.id));
    if (reachableEndNodes.length === 0) {
      throw new Error(
        `工作流无效：所有 END 节点都不可达，无法从 START 节点到达任何 END 节点`,
      );
    }

    // 6) 警告：如果有 END 节点不可达
    const unreachableEndNodes = endNodes.filter((n) => !reachable.has(n.id));
    if (unreachableEndNodes.length > 0) {
      logError(
        `警告：${unreachableEndNodes.length} 个 END 节点不可达：${unreachableEndNodes.map((n) => n.id).join(", ")}`,
      );
    }

    return reachable;
  }

  /**
   * ============================================================================
   * 【方法】executeNode() - 执行节点：根据节点类型调用对应的节点函数
   * ============================================================================
   *
   * 【用途】
   * 根据 node.type 调用对应的节点实现（emotionDetectionNode/chatNode 等）
   * 上游：build() 方法的 addNode 回调调用此方法
   * 下游：调用具体的节点实现（workflow-node/index.ts）
   *
   * 【核心流程】
   * 1) 根据 node.type 匹配对应的 case
   * 2) 调用对应的节点函数（如 emotionDetectionNode）
   * 3) 返回节点的执行结果（Partial<WorkflowState>）
   *
   * 【参数说明】
   * @param node - 节点配置对象
   *   → 来自 config.nodes 数组
   *   → 最小字段示例：{id: "emotion", type: "EMOTION_DETECTOR", config: {...}}
   *
   * @param state - 当前工作流状态
   *   → 来自 workflow.invoke() 的入参
   *   → 最小字段示例：{messages: [...], currentTicket: {...}, response: ""}
   *
   * 【数据快照】
   * 返回值：Partial<WorkflowState>
   *   → 包含节点更新的状态字段（如 {sentimentLabel: "NEGATIVE"}）
   *   → LangGraph 会合并到全局状态中
   *
   * 【错误与边界】
   * - 未知节点类型：logError，返回 {}（第 505-506 行）
   * - 节点函数抛错：向上抛出，LangGraph 会处理
   */
  private async executeNode(
    node:
      | EmotionDetectionConfig
      | HandoffConfig
      | EscalationOfferConfig
      | SmartChatConfig
      | RagConfig
      | McpConfig,
    state: WorkflowState,
  ): Promise<Partial<WorkflowState>> {
    // 翻译：switch (node.type) 根据 node.type 匹配对应的 case
    // 目的：调用对应的节点实现（每个节点类型有不同的处理逻辑）
    switch (node.type) {
      case NodeType.EMOTION_DETECTOR:
        return await emotionDetectionNode(state, node.config);
      case NodeType.SMART_CHAT:
        return await chatNode(state, node.config);
      case NodeType.HANDOFF:
        return await handoffNode(state, node.config);
      case NodeType.ESCALATION_OFFER:
        return await escalationOfferNode(state, node.config);
      case NodeType.RAG:
        return await ragNode(state, node.config);
      case NodeType.MCP:
        return await mcpNode(state, node.config);
      default:
        // 未知节点类型：记录错误并返回空状态
        logError(`Unknown node type: ${(node as BaseNodeConfig).type}`);
        return {};
    }
  }
}

/**
 * ============================================================================
 * 【函数】evaluateCondition() - 动态评估条件表达式
 * ============================================================================
 *
 * 【用途】
 * 将字符串形式的条件表达式转换成布尔值（用于条件边判断）
 * 上游：build() 方法的 addConditionalEdges 回调调用此函数
 *
 * 【核心流程】
 * 1) 使用 new Function 创建动态函数
 * 2) 将变量作为参数传入
 * 3) 执行表达式并返回布尔值
 * 4) 如果出错，返回 false
 *
 * 【参数说明】
 * @param expression - 条件表达式字符串
 *   → 来自 edge.condition 字段
 *   → 示例："sentimentLabel === 'NEGATIVE'"、"handoffRequired === true"
 *
 * @param variables - 变量对象
 *   → 来自 getVariables(state)，包含当前状态的变量
 *   → 示例：{sentimentLabel: "NEGATIVE", handoffRequired: true}
 *
 * 【数据快照】
 * 入参示例：
 *   expression: "sentimentLabel === 'NEGATIVE'"
 *   variables: {sentimentLabel: "NEGATIVE", handoffRequired: false}
 * 返回值：true
 *
 * 执行逻辑等价于：
 *   const sentimentLabel = "NEGATIVE";
 *   const handoffRequired = false;
 *   return sentimentLabel === 'NEGATIVE';  // 返回 true
 *
 * 【错误与边界】
 * - 表达式语法错误：catch 错误，logError，返回 false（第 571-575 行）
 * - 变量未定义：抛出 ReferenceError，catch 后返回 false
 * - 安全风险：new Function 可以执行任意代码，但 variables 来自可控的 state
 *
 * 【为什么用 new Function 而不是 eval】
 * - new Function 创建的函数在全局作用域执行，更安全
 * - 可以提前绑定变量，避免作用域污染
 */
function evaluateCondition(
  expression: string,
  variables: Record<string, any>,
): boolean {
  try {
    // 翻译：new Function(...Object.keys(variables), `return ${expression}`)
    // 意思：创建一个函数，参数是变量名，函数体返回条件表达式的结果
    // 例如：new Function('sentimentLabel', 'handoffRequired', "return sentimentLabel === 'NEGATIVE'")
    const func = new Function(
      ...Object.keys(variables),
      `return ${expression}`,
    );
    // 翻译：func(...Object.values(variables)) 调用函数，传入变量值
    const result = func(...Object.values(variables));
    return result;
  } catch (error) {
    // 翻译：catch (error) 捕获函数执行中的错误
    // 目的：条件评估失败时不阻塞 workflow，走默认边
    logError(`[Condition] Failed to evaluate: ${expression}`, error);
    return false;
  }
}

// ============================================================================
// 【学习建议】
// ============================================================================
/*
【我最该从哪 3 个函数开始读】
1. build() - 第 194-344 行
   → 理解 workflow 的编译流程（节点 + 边 + 编译）
   → 注意：为什么要过滤孤岛节点？START 节点为什么只能有一条边？

2. findReachableNodes() - 第 374-447 行
   → 理解 BFS 遍历算法和可达性检查
   → 注意：为什么要验证 END 节点可达？不可达会怎样？

3. executeNode() - 第 482-509 行
   → 理解节点类型和节点实现的映射关系
   → 注意：如果要添加新节点类型，需要修改哪里？

【我想改 A/B/C 功能，各自最可能改哪一段 + 风险点 + 如何验证】

A. 添加新的节点类型（如 "TRANSLATE" 翻译节点）
   → 改哪里：
     1) @/utils/const.ts 添加 NodeType.TRANSLATE 和 TranslateConfig 类型
     2) workflow-node/index.ts 添加 translateNode() 函数
     3) 第 493-503 行（executeNode 方法）：添加 case NodeType.TRANSLATE
   → 风险点：
     1) 节点函数签名必须符合 (state, config) => Promise<Partial<WorkflowState>>
     2) 节点函数抛错会导致整个 workflow 失败
     3) 节点返回的状态会被 LangGraph 合并到全局状态
   → 如何验证：
     1) 单元测试：mock translateNode()，检查是否被正确调用
     2) 集成测试：创建包含 TRANSLATE 节点的 workflow，检查执行结果
     3) 手动测试：在 workflow 表中添加该节点，调用 invoke() 验证

B. 修改边的规则（如允许多条 START 边）
   → 改哪里：第 278-294 行（START 节点的边构建逻辑）
   → 风险点：
     1) 多条 START 边会导致 workflow 入口点不明确
     2) 如果允许多条边，需要明确默认走哪条（可能需要条件判断）
     3) LangGraph 的 START 常量可能不支持多条边
   → 如何验证：
     1) 单元测试：创建包含多条 START 边的 workflow，检查是否抛错
     2) 集成测试：修改后创建多条 START 边，检查编译是否成功
     3) 手动测试：在 workflow 表中添加多条 START 边，观察 invoke() 的行为

C. 修改条件评估逻辑（如支持更复杂的表达式，如 AND/OR）
   → 改哪里：第 556-577 行（evaluateCondition 函数）
   → 风险点：
     1) new Function 可以执行任意代码，需要确保表达式来源可信
     2) 复杂表达式可能导致性能问题（如循环引用）
     3) 表达式错误会导致走默认边（可能不符合预期）
   → 如何验证：
     1) 单元测试：测试各种表达式（简单/复杂/错误），检查返回值
     2) 安全测试：注入恶意代码（如 infinite loop），检查是否有沙箱保护
     3) 性能测试：测试复杂表达式的评估时间，确保不影响 workflow 执行

【如何快速验证我的理解】
1. 阅读 WorkflowConfig 类型定义（@/utils/const.ts）
2. 阅读 NodeType 枚举定义（@/utils/const.ts）
3. 阅读 WorkflowState 类型定义（workflow-node/index.ts）
4. 创建一个简单的 workflow（START -> SMART_CHAT -> END），调用 build() 并打印结果
5. 修改 workflow 配置（如孤岛节点、多条 START 边），观察错误信息

【常见疑问解答】
Q: 为什么要用 nodeMap 而不是直接用 config.nodes.find()？
A: nodeMap 是 O(1) 查找，find() 是 O(n) 查找。workflow 可能有几十个节点，用 Map 提高性能。

Q: 为什么要过滤孤岛节点？直接编译不行吗？
A: 可以编译，但孤岛节点永远不会执行（从 START 不可达）。过滤掉可以避免浪费资源，同时警告用户配置可能有误。

Q: START 节点为什么只能有一条边？
A: START 是 workflow 的入口点，多条边会导致入口点不明确（LangGraph 的限制）。如果需要条件判断，应该在后续节点用条件边。

Q: 条件边的表达式是怎么执行的？安全吗？
A: 使用 new Function 动态创建函数并执行。表达式来自 DB（管理员配置），相对安全。但如果 DB 被攻击，可能注入恶意代码。

Q: 如何添加一个条件边（如 "如果情绪是 NEGATIVE，转到人工客服"）？
A: 在 edges 数组中添加一条边：{source: "emotion", target: "handoff", condition: "sentimentLabel === 'NEGATIVE'"}
*/
