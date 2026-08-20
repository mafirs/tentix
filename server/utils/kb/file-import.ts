export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_FILE_MAX_CANDIDATES = 100;
export const KNOWLEDGE_FILE_MAX_CONTENT_LENGTH = 20_000;

export type KnowledgeFileSplitOptions = {
  chunkSize: number;
  overlapRatio: number;
  maxChunks: number;
};

export type KnowledgeFileCandidate = {
  title: string;
  content: string;
};

export class KnowledgeFileParseError extends Error {}

type KnowledgeFileSection = {
  title: string;
  lines: string[];
  boundary: boolean;
};

const SPLIT_BOUNDARIES = new Set([
  "。",
  "！",
  "？",
  "；",
  "，",
  ".",
  "!",
  "?",
  ";",
  ",",
  "\n",
]);

function normalizeLineEndings(rawText: string): string {
  return rawText.replace(/\r\n?/g, "\n");
}

function getHeading(line: string): { level: number; title: string } | null {
  const match = /^[ \t]{0,3}(#{1,8})[ \t]+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return {
    level: match[1]!.length,
    title: match[2]!
      .replace(/\s+#+\s*$/, "")
      .replace(/\\(.)/g, "$1")
      .trim(),
  };
}

function isFence(line: string): boolean {
  return /^[ \t]{0,3}(`{3,}|~{3,})/.test(line);
}

function createSectionCandidate(
  section: KnowledgeFileSection,
): KnowledgeFileCandidate | null {
  const content = section.lines.join("\n");
  if (!content.trim()) return null;
  if (section.boundary && !section.lines.slice(1).join("\n").trim()) {
    return null;
  }
  return {
    title: section.title,
    content,
  };
}

function findSplitEnd(content: string, start: number, maxEnd: number): number {
  const minimumEnd = Math.min(
    maxEnd,
    start + Math.max(1, Math.floor((maxEnd - start) * 0.5)),
  );
  for (let index = maxEnd - 1; index >= minimumEnd; index -= 1) {
    if (SPLIT_BOUNDARIES.has(content[index]!)) return index + 1;
  }
  return maxEnd;
}

function splitSectionContent(
  content: string,
  options: KnowledgeFileSplitOptions,
): string[] {
  if (content.length <= options.chunkSize) return [content];

  const chunks: string[] = [];
  const overlap = Math.floor(options.chunkSize * options.overlapRatio);
  let start = 0;

  while (start < content.length) {
    const remaining = content.length - start;
    if (remaining <= options.chunkSize) {
      chunks.push(content.slice(start));
      break;
    }

    let end = findSplitEnd(content, start, start + options.chunkSize);
    const tailLength = content.length - end;
    if (tailLength > 0 && tailLength < options.chunkSize * 0.8) {
      end = content.length;
    }

    chunks.push(content.slice(start, end));
    if (end >= content.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

function collectSections(rawText: string): KnowledgeFileSection[] {
  const lines = rawText.split("\n");
  let inFence = false;
  let firstBoundaryIndex = -1;
  for (const [index, line] of lines.entries()) {
    const heading = inFence ? null : getHeading(line);
    if (heading?.level === 1 || heading?.level === 2) {
      firstBoundaryIndex = index;
      break;
    }
    if (isFence(line)) inFence = !inFence;
  }

  if (firstBoundaryIndex === -1) {
    return [{ title: "", lines, boundary: false }];
  }

  const sections: KnowledgeFileSection[] = [];
  const preamble = lines.slice(0, firstBoundaryIndex);
  if (preamble.join("\n").trim()) {
    sections.push({ title: "", lines: preamble, boundary: false });
  }

  let current: KnowledgeFileSection | null = null;
  let currentH1 = "";
  inFence = false;

  const flush = () => {
    if (!current) return;
    sections.push(current);
    current = null;
  };

  for (const line of lines.slice(firstBoundaryIndex)) {
    const heading = inFence ? null : getHeading(line);
    if (isFence(line)) inFence = !inFence;
    if (heading?.level === 1) {
      flush();
      currentH1 = heading.title;
      current = { title: currentH1, lines: [line], boundary: true };
      continue;
    }
    if (heading?.level === 2) {
      flush();
      current = {
        title: currentH1 ? `${currentH1} > ${heading.title}` : heading.title,
        lines: [line],
        boundary: true,
      };
      continue;
    }
    if (!current) {
      current = { title: "", lines: [], boundary: false };
    }
    current.lines.push(line);
  }
  flush();
  return sections;
}

export function normalizeKnowledgeDuplicateContent(content: string): string {
  return normalizeLineEndings(content).normalize("NFC").trim();
}

export function splitKnowledgeFile(
  rawText: string,
  options: KnowledgeFileSplitOptions,
): KnowledgeFileCandidate[] {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0) {
    throw new KnowledgeFileParseError("每条内容长度必须是正整数");
  }
  if (options.overlapRatio < 0 || options.overlapRatio > 0.4) {
    throw new KnowledgeFileParseError("内容重叠必须在 0% 到 40% 之间");
  }
  if (!Number.isInteger(options.maxChunks) || options.maxChunks <= 0) {
    throw new KnowledgeFileParseError("最大候选数量必须是正整数");
  }

  const normalizedText = normalizeLineEndings(rawText);
  const candidates: KnowledgeFileCandidate[] = [];
  for (const section of collectSections(normalizedText)) {
    const candidate = createSectionCandidate(section);
    if (!candidate) continue;
    for (const content of splitSectionContent(candidate.content, options)) {
      if (!content.trim()) continue;
      candidates.push({ title: candidate.title, content });
      if (candidates.length > options.maxChunks) {
        throw new KnowledgeFileParseError(
          options.maxChunks < KNOWLEDGE_FILE_MAX_CANDIDATES
            ? `解析结果超过当前最大候选数量 ${options.maxChunks} 条，请提高上限`
            : "解析结果超过 100 条，请拆分文件",
        );
      }
    }
  }

  return candidates;
}
