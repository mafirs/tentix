import { describe, expect, test } from "bun:test";
import {
  normalizeKnowledgeDuplicateContent,
  splitKnowledgeFile,
} from "../utils/kb/file-import.ts";

describe("knowledge file import parser", () => {
  test("uses absolute H1 and H2 boundaries and keeps H3 content", () => {
    const candidates = splitKnowledgeFile(
      "# 支付\n\n前言说明\n\n## 退款\n\n退款说明\n\n### 处理方式\n\n处理说明\n\n## 订单\n\n订单说明",
      {
        chunkSize: 1200,
        overlapRatio: 0.1,
        maxChunks: 100,
      },
    );

    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.title).toBe("支付");
    expect(candidates[0]?.content).toContain("前言说明");
    expect(candidates[1]?.title).toBe("支付 > 退款");
    expect(candidates[1]?.content).toContain("## 退款");
    expect(candidates[1]?.content).toContain("### 处理方式");
    expect(candidates[2]?.title).toBe("支付 > 订单");
    expect(candidates[2]?.content).toContain("## 订单");
  });

  test("creates a candidate for H1-only direct content", () => {
    const candidates = splitKnowledgeFile("# 支付说明\n\n支付正文", {
      chunkSize: 1200,
      overlapRatio: 0,
      maxChunks: 100,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("支付说明");
    expect(candidates[0]?.content).toContain("# 支付说明");
  });

  test("keeps H3 content under H1 when no H2 exists", () => {
    const candidates = splitKnowledgeFile(
      "# 支付\n\n说明\n\n### 处理方式\n\n处理说明",
      { chunkSize: 1200, overlapRatio: 0, maxChunks: 100 },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("支付");
    expect(candidates[0]?.content).toContain("### 处理方式");
  });

  test("keeps one empty-title candidate when no H1 or H2 exists", () => {
    const candidates = splitKnowledgeFile(
      "### 处理方式\n\n处理说明",
      { chunkSize: 1200, overlapRatio: 0, maxChunks: 100 },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("");
    expect(candidates[0]?.content).toContain("### 处理方式");
  });

  test("uses an H2 title when the document has no H1", () => {
    const [candidate] = splitKnowledgeFile("## 退款\n\n退款说明", {
      chunkSize: 1200,
      overlapRatio: 0,
      maxChunks: 100,
    });

    expect(candidate?.title).toBe("退款");
    expect(candidate?.content).toContain("## 退款");
  });

  test("keeps title empty for text without a heading", () => {
    const [candidate] = splitKnowledgeFile("普通文本", {
      chunkSize: 1200,
      overlapRatio: 0,
      maxChunks: 100,
    });
    expect(candidate?.title).toBe("");
  });

  test("does not treat headings inside fenced code as boundaries", () => {
    const [candidate] = splitKnowledgeFile(
      "# 示例\n\n```md\n## 代码中的标题\n```\n\n正文",
      { chunkSize: 1200, overlapRatio: 0, maxChunks: 100 },
    );

    expect(candidate?.title).toBe("示例");
    expect(candidate?.content).toContain("## 代码中的标题");
  });

  test("splits long content with the configured overlap and rejects over-limit output", () => {
    const text = "第一段。".repeat(500);
    const chunks = splitKnowledgeFile(text, {
      chunkSize: 200,
      overlapRatio: 0.1,
      maxChunks: 100,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(() =>
      splitKnowledgeFile(text, {
        chunkSize: 200,
        overlapRatio: 0,
        maxChunks: 1,
      }),
    ).toThrow();
  });

  test("normalizes only outer whitespace and line endings for duplicate checks", () => {
    expect(normalizeKnowledgeDuplicateContent("  a\r\nb  ")).toBe("a\nb");
    expect(normalizeKnowledgeDuplicateContent("a  b")).not.toBe("a b");
  });
});
