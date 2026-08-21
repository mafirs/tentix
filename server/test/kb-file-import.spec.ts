import { describe, expect, test } from "bun:test";
import {
  normalizeKnowledgeDuplicateContent,
  splitKnowledgeFile,
} from "../utils/kb/file-import.ts";

const customOptions = (overrides: Record<string, unknown> = {}) => ({
  chunkSettingMode: "custom" as const,
  chunkSplitMode: "paragraph" as const,
  paragraphChunkDeep: 2,
  chunkSize: 1200,
  ...overrides,
});

describe("knowledge file import parser", () => {
  test("custom paragraph depth 2 keeps H3 content inside the H2 candidate", () => {
    const candidates = splitKnowledgeFile(
      "# 支付\n\n前言说明\n\n## 退款\n\n退款说明\n\n### 处理方式\n\n处理说明\n\n## 订单\n\n订单说明",
      customOptions(),
    );

    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.title).toBe("支付");
    expect(candidates[0]?.content).toContain("前言说明");
    expect(candidates[1]?.title).toBe("退款");
    expect(candidates[1]?.content).toContain("## 退款");
    expect(candidates[1]?.content).toContain("### 处理方式");
    expect(candidates[2]?.title).toBe("订单");
    expect(candidates[2]?.content).toContain("## 订单");
  });

  test("creates an H1 candidate for direct H1 content", () => {
    const candidates = splitKnowledgeFile(
      "# 支付说明\n\n支付正文",
      customOptions(),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("支付说明");
    expect(candidates[0]?.content).toContain("# 支付说明");
  });

  test("keeps H3 content under H1 when paragraph depth is 2", () => {
    const candidates = splitKnowledgeFile(
      "# 支付\n\n说明\n\n### 处理方式\n\n处理说明",
      customOptions(),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("支付");
    expect(candidates[0]?.content).toContain("### 处理方式");
  });

  test("keeps one empty-title candidate when no usable heading exists", () => {
    const candidates = splitKnowledgeFile(
      "### 处理方式\n\n处理说明",
      customOptions(),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("");
    expect(candidates[0]?.content).toContain("### 处理方式");
  });

  test("uses an absolute H2 title when the document has no H1", () => {
    const [candidate] = splitKnowledgeFile(
      "## 退款\n\n退款说明",
      customOptions(),
    );

    expect(candidate?.title).toBe("退款");
    expect(candidate?.content).toContain("## 退款");
  });

  test("keeps title empty for text without a heading", () => {
    const [candidate] = splitKnowledgeFile("普通文本", customOptions());
    expect(candidate?.title).toBe("");
  });

  test("does not treat headings inside fenced code as boundaries", () => {
    const [candidate] = splitKnowledgeFile(
      "# 示例\n\n```md\n## 代码中的标题\n```\n\n正文",
      customOptions(),
    );

    expect(candidate?.title).toBe("示例");
    expect(candidate?.content).toContain("## 代码中的标题");
  });

  test("splits long content with FastGPT paragraph rules and rejects over-limit output", () => {
    const text = "第一段。".repeat(2000);
    const chunks = splitKnowledgeFile(
      text,
      customOptions({ chunkSize: 200 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(() =>
      splitKnowledgeFile(
        text,
      customOptions({ chunkSize: 64, paragraphChunkDeep: 2 }),
      ),
    ).toThrow();
  });

  test("starts length-split candidates at complete sentence boundaries", () => {
    const text = Array.from(
      { length: 80 },
      (_, index) => `第${index + 1}句内容。`,
    ).join("");
    const chunks = splitKnowledgeFile(
      text,
      customOptions({ chunkSize: 64 }),
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) {
      expect(chunk.content).toMatch(/^第\d+句内容。/);
    }
  });

  test("filters a heading without a knowledge body", () => {
    expect(
      splitKnowledgeFile("# 只有标题", customOptions()),
    ).toHaveLength(0);
  });

  test("default mode uses FastGPT paragraph settings without client numeric options", () => {
    const candidates = splitKnowledgeFile("# 标题\n\n正文", {
      chunkSettingMode: "auto",
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.content).toContain("# 标题");
  });

  test("paragraph depth 1 does not split H2 and depth 3 can split H3", () => {
    const text = "# 一级\n\n## 二级\n\n二级正文\n\n### 三级\n\n三级正文";
    const depth1 = splitKnowledgeFile(
      text,
      customOptions({ paragraphChunkDeep: 1 }),
    );
    const depth3 = splitKnowledgeFile(
      text,
      customOptions({ paragraphChunkDeep: 3 }),
    );
    expect(depth1).toHaveLength(1);
    expect(depth3).toHaveLength(2);
    expect(depth3[1]?.title).toBe("三级");
  });

  test("normalizes only outer whitespace and line endings for duplicate checks", () => {
    expect(normalizeKnowledgeDuplicateContent("  a\r\nb  ")).toBe("a\nb");
    expect(normalizeKnowledgeDuplicateContent("a  b")).not.toBe("a b");
  });
});
