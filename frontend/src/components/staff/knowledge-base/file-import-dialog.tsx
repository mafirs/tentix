import {
  apiClient,
  kbAdminSaveFetch,
  kbFilePreviewFetch,
  kbIndexGenerateFetch,
} from "@lib/api-client";
import {
  GENERAL_KNOWLEDGE_CATEGORY_LABELS,
  GENERAL_KNOWLEDGE_CATEGORY_VALUES,
  KnowledgeFieldsEditor,
  type GeneralKnowledgeCategory,
  type KnowledgeFieldErrors,
  type KnowledgeFieldValues,
} from "@comp/staff/knowledge-base/knowledge-fields-editor";
import { useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "tentix-ui";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MODULES = 10;
const MAX_INDEXES = 3;

type FileImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  moduleOptions: Array<{ code: string; label: string }>;
  onImported: () => void;
};

type FileImportCandidate = KnowledgeFieldValues & {
  candidateId: string;
  initialContent: string;
  contentModified: boolean;
  errors?: KnowledgeFieldErrors;
  duplicate: "none" | "current" | "existing";
  duplicateAction: "continue" | "skip";
  indexStatus: "idle" | "running" | "success" | "failed";
  importStatus: "pending" | "running" | "success" | "failed" | "skipped";
  error?: string;
};

function getResponseMessage(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = data.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}));
  return getResponseMessage(data, fallback);
}

function normalizeDuplicateContent(content: string): string {
  return content.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

async function getFileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        await worker(items[index]!);
      }
    }),
  );
}

async function saveFileImportCandidate(
  candidate: FileImportCandidate,
  fileName: string,
): Promise<void> {
  const response = await apiClient.kb.admin["general-knowledge"].$post(
    {
      json: {
        sourceId: `general_knowledge:file:${candidate.candidateId}`,
        title: candidate.title.trim(),
        modules: candidate.modules,
        category: candidate.category as GeneralKnowledgeCategory,
        docName: fileName,
        revision: candidate.revision.trim(),
        content: candidate.content.trim(),
        indexes: candidate.indexes.filter((value) => value.trim()),
      },
    },
    { fetch: kbAdminSaveFetch },
  );
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "导入通用知识失败"));
  }
}

function validateCandidate(candidate: FileImportCandidate): KnowledgeFieldErrors | undefined {
  const errors: KnowledgeFieldErrors = {};
  if (!candidate.title.trim()) errors.title = "标题不能为空";
  if (candidate.modules.length === 0) errors.modules = "至少选择一个模块";
  if (candidate.modules.length > MAX_MODULES) {
    errors.modules = `模块数量不能超过 ${MAX_MODULES} 个`;
  }
  if (!candidate.category) errors.category = "请选择知识类型";
  if (!candidate.revision.trim()) errors.revision = "版本不能为空";
  if (!candidate.content.trim()) errors.content = "正文不能为空";
  if (candidate.content.trim().length > 20_000) {
    errors.content = "正文不能超过 20000 个字符";
  }
  if (candidate.indexes.length > MAX_INDEXES) {
    errors.indexes = ["召回索引最多 3 条"];
  }
  return Object.keys(errors).length ? errors : undefined;
}

export function FileImportDialog({
  open,
  onOpenChange,
  moduleOptions,
  onImported,
}: FileImportDialogProps) {
  const fileFingerprints = useRef(new Map<string, string>());
  const fileReadVersion = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  const [rawText, setRawText] = useState("");
  const [fileWarning, setFileWarning] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [candidates, setCandidates] = useState<FileImportCandidate[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [defaultModules, setDefaultModules] = useState<string[]>([]);
  const [defaultCategory, setDefaultCategory] =
    useState<GeneralKnowledgeCategory | "">("");
  const [bulkModules, setBulkModules] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState<GeneralKnowledgeCategory | "">("");
  const [splitOptions, setSplitOptions] = useState({
    chunkSize: 1200,
    overlapRatio: 0.1,
    maxChunks: 100,
  });
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const selectedCandidate =
    candidates.find((item) => item.candidateId === selectedCandidateId) ??
    candidates[0] ??
    null;
  const availableModuleOptions = moduleOptions.filter((item) =>
    defaultModules.includes(item.code),
  );

  const setCandidateValues = (candidateId: string, value: KnowledgeFieldValues) => {
    setCandidates((current) =>
      current.map((item) =>
        item.candidateId === candidateId
          ? {
              ...item,
              ...value,
              contentModified: value.content !== item.initialContent,
              errors: undefined,
              error: undefined,
            }
          : item,
      ),
    );
  };

  const handleFileChange = async (nextFile: File | undefined) => {
    if (!nextFile) return;
    const readVersion = fileReadVersion.current + 1;
    fileReadVersion.current = readVersion;
    const extension = nextFile.name.split(".").pop()?.toLowerCase();
    if (extension !== "md" && extension !== "txt") {
      setErrorMessage("仅支持 .md 和 .txt 文件");
      setFile(null);
      setFileName("");
      setFileSizeBytes(0);
      setRawText("");
      setCandidates([]);
      setSelectedCandidateIds([]);
      setSelectedCandidateId("");
      setIsReadingFile(false);
      return;
    }
    if (nextFile.size > MAX_FILE_BYTES) {
      setErrorMessage("文件不能超过 10 MB");
      setFile(null);
      setFileName("");
      setFileSizeBytes(0);
      setRawText("");
      setCandidates([]);
      setSelectedCandidateIds([]);
      setSelectedCandidateId("");
      setIsReadingFile(false);
      return;
    }

    setErrorMessage("");
    setFileWarning("");
    setIsReadingFile(true);
    setFile(nextFile);
    setFileName(nextFile.name);
    setFileSizeBytes(nextFile.size);
    setCandidates([]);
    setSelectedCandidateIds([]);
    setSelectedCandidateId("");

    try {
      const fingerprint = await getFileFingerprint(nextFile);
      if (fileReadVersion.current !== readVersion) return;
      const previousName = fileFingerprints.current.get(fingerprint);
      if (previousName) {
        setFileWarning(`本次页面会话已选择过内容相同的文件（上次文件名：${previousName}）`);
      }
      fileFingerprints.current.set(fingerprint, nextFile.name);
      const nextRawText = await nextFile.text();
      if (fileReadVersion.current !== readVersion) return;
      setRawText(nextRawText);
    } catch {
      if (fileReadVersion.current !== readVersion) return;
      setErrorMessage("文件读取失败，请重新选择文件");
      setRawText("");
    } finally {
      if (fileReadVersion.current === readVersion) setIsReadingFile(false);
    }
  };

  const getSelectedIds = () => selectedCandidateIds;

  const requestPreview = async () => {
    if (isReadingFile) {
      setErrorMessage("文件仍在读取，请稍候");
      return;
    }
    if (!file) {
      setErrorMessage("请先选择文件");
      return;
    }
    if (!rawText) {
      setErrorMessage("文件内容为空，无法解析");
      return;
    }
    if (!defaultModules.length) {
      setErrorMessage("请先选择本次导入可使用的工单模块");
      return;
    }
    if (!defaultCategory) {
      setErrorMessage("请先选择默认知识类型");
      return;
    }
    if (
      !Number.isInteger(splitOptions.chunkSize) ||
      splitOptions.chunkSize < 200 ||
      splitOptions.chunkSize > 4000 ||
      splitOptions.overlapRatio < 0 ||
      splitOptions.overlapRatio > 0.4 ||
      !Number.isInteger(splitOptions.maxChunks) ||
      splitOptions.maxChunks < 1 ||
      splitOptions.maxChunks > 100
    ) {
      setErrorMessage("请检查分块参数范围");
      return;
    }

    setIsParsing(true);
    setErrorMessage("");
    try {
      const response = await apiClient.kb.admin["general-knowledge"].file.preview.$post(
        {
          json: {
            fileName,
            fileSizeBytes,
            rawText,
            ...splitOptions,
          },
        },
        { fetch: kbFilePreviewFetch },
      );
      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "文件解析失败"));
      }
      const result = await response.json();
      const parsedCandidates = result.data.candidates.map((candidate) => ({
        title: candidate.title,
        content: candidate.content,
        modules: [],
        category: defaultCategory,
        revision: `file-${new Date().toISOString().slice(0, 10)}`,
        indexes: [],
        candidateId: candidate.candidateId,
        initialContent: candidate.content,
        contentModified: false,
        duplicate: "none" as const,
        duplicateAction: "continue" as const,
        indexStatus: "idle" as const,
        importStatus: "pending" as const,
      }));

      const duplicateResponse =
        await apiClient.kb.admin["general-knowledge"].file.duplicates.$post({
          json: {
            candidates: parsedCandidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              content: candidate.content,
            })),
          },
        });
      if (!duplicateResponse.ok) {
        throw new Error(await getErrorMessage(duplicateResponse, "重复检查失败"));
      }
      const duplicateResult = await duplicateResponse.json();
      const existingMatches = new Set(
        duplicateResult.data.matches
          .filter((match) => match.existing.length > 0)
          .map((match) => match.candidateId),
      );
      const currentContent = new Map<string, string>();
      const candidatesWithDuplicates: FileImportCandidate[] = parsedCandidates.map((candidate) => {
        const normalized = normalizeDuplicateContent(candidate.content);
        const isCurrentDuplicate = currentContent.has(normalized);
        currentContent.set(normalized, candidate.candidateId);
        return {
          ...candidate,
          duplicate: isCurrentDuplicate
            ? "current"
            : existingMatches.has(candidate.candidateId)
              ? "existing"
              : "none",
        };
      });

      setCandidates(candidatesWithDuplicates);
      setSelectedCandidateIds(candidatesWithDuplicates.map((candidate) => candidate.candidateId));
      setSelectedCandidateId(candidatesWithDuplicates[0]?.candidateId ?? "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "文件解析失败");
      setCandidates([]);
      setSelectedCandidateIds([]);
      setSelectedCandidateId("");
    } finally {
      setIsParsing(false);
    }
  };

  const handleRechunk = () => {
    if (candidates.length && !window.confirm("重新分块会替换当前候选的编辑内容，是否继续？")) {
      return;
    }
    void requestPreview();
  };

  const generateIndexes = async (items: FileImportCandidate[]) => {
    const validation = items.map((candidate) => ({
      candidate,
      errors: validateCandidate(candidate),
    }));
    const validItems = validation
      .filter((item) => !item.errors)
      .map((item) => item.candidate);
    setCandidates((current) =>
      current.map((candidate) => {
        const itemValidation = validation.find(
          (item) => item.candidate.candidateId === candidate.candidateId,
        );
        if (!itemValidation) {
          return candidate;
        }
        if (itemValidation.errors) {
          return {
            ...candidate,
            errors: itemValidation.errors,
            indexStatus: "idle" as const,
          };
        }
        return {
          ...candidate,
          errors: undefined,
          indexStatus: "running" as const,
          error: undefined,
        };
      }),
    );

    await runWithConcurrency(validItems, 2, async (candidate) => {
      try {
        const response = await apiClient.kb.admin["general-knowledge"].indexes.generate.$post(
          {
            json: {
              title: candidate.title,
              modules: candidate.modules,
              category: candidate.category as GeneralKnowledgeCategory,
              content: candidate.content,
            },
          },
          { fetch: kbIndexGenerateFetch },
        );
        if (!response.ok) {
          throw new Error(await getErrorMessage(response, "召回索引生成失败"));
        }
        const result = await response.json();
        setCandidates((current) =>
          current.map((item) => {
            if (item.candidateId !== candidate.candidateId) return item;
            const indexes = [...item.indexes];
            let nextIndex = 0;
            for (let index = 0; index < MAX_INDEXES && nextIndex < result.data.indexes.length; index += 1) {
              if (indexes[index]?.trim()) continue;
              indexes[index] = result.data.indexes[nextIndex]!;
              nextIndex += 1;
            }
            return { ...item, indexes, indexStatus: "success" as const };
          }),
        );
      } catch (error) {
        setCandidates((current) =>
          current.map((item) =>
            item.candidateId === candidate.candidateId
              ? {
                  ...item,
                  indexStatus: "failed" as const,
                  error: error instanceof Error ? error.message : "召回索引生成失败",
                }
              : item,
          ),
        );
      }
    });
  };

  const handleGenerateIndexes = () => {
    void generateIndexes(
      candidates.filter((candidate) => getSelectedIds().includes(candidate.candidateId)),
    );
  };

  const handleImport = async (requestedCandidates?: FileImportCandidate[]) => {
    const selected = requestedCandidates ?? candidates.filter((candidate) =>
      getSelectedIds().includes(candidate.candidateId),
    );
    const validation = selected.map((candidate) => ({
      candidate,
      errors: validateCandidate(candidate),
    }));
    const validItems = validation
      .filter(
        (item) =>
          !item.errors &&
          item.candidate.importStatus !== "success" &&
          item.candidate.importStatus !== "skipped" &&
          !(item.candidate.duplicateAction === "skip" && item.candidate.duplicate !== "none"),
      )
      .map((item) => item.candidate);
    setCandidates((current) =>
      current.map((candidate) => {
        const itemValidation = validation.find(
          (item) => item.candidate.candidateId === candidate.candidateId,
        );
        if (!itemValidation) {
          return candidate;
        }
        if (candidate.importStatus === "success" || candidate.importStatus === "skipped") {
          return candidate;
        }
        if (itemValidation.errors) {
          return { ...candidate, errors: itemValidation.errors };
        }
        if (candidate.duplicateAction === "skip" && candidate.duplicate !== "none") {
          return { ...candidate, importStatus: "skipped" as const, errors: undefined };
        }
        return { ...candidate, errors: undefined, importStatus: "running" as const, error: undefined };
      }),
    );
    if (!validItems.length) return;

    setIsImporting(true);
    let importedCount = 0;
    await runWithConcurrency(validItems, 2, async (candidate) => {
      try {
        await saveFileImportCandidate(candidate, fileName);
        importedCount += 1;
        setCandidates((current) =>
          current.map((item) =>
            item.candidateId === candidate.candidateId
              ? { ...item, importStatus: "success" as const }
              : item,
          ),
        );
      } catch (error) {
        setCandidates((current) =>
          current.map((item) =>
            item.candidateId === candidate.candidateId
              ? {
                  ...item,
                  importStatus: "failed" as const,
                  error: error instanceof Error ? error.message : "导入通用知识失败",
                }
              : item,
          ),
        );
      }
    });
    setIsImporting(false);
    if (importedCount) onImported();
  };

  const applyBulkSettings = () => {
    const ids = new Set(selectedCandidateIds);
    if (bulkModules.length > MAX_MODULES) {
      setErrorMessage(`模块数量不能超过 ${MAX_MODULES} 个`);
      return;
    }
    if (!ids.size) {
      setErrorMessage("请先选择候选知识");
      return;
    }
    setCandidates((current) =>
      current.map((candidate) =>
        ids.has(candidate.candidateId)
          ? {
              ...candidate,
              modules: bulkModules.length ? bulkModules : candidate.modules,
              category: bulkCategory || candidate.category,
              errors: undefined,
            }
          : candidate,
      ),
    );
  };

  const toggleCandidate = (candidateId: string, checked: boolean) => {
    setSelectedCandidateIds((current) =>
      checked
        ? Array.from(new Set([...current, candidateId]))
        : current.filter((id) => id !== candidateId),
    );
  };

  const selectedCount = selectedCandidateIds.length;
  const pendingCount = candidates.filter(
    (candidate) => candidate.importStatus === "pending" || candidate.importStatus === "running",
  ).length;
  const successCount = candidates.filter((candidate) => candidate.importStatus === "success").length;
  const failedCount = candidates.filter((candidate) => candidate.importStatus === "failed").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>导入知识库文件</DialogTitle>
          <p className="text-sm text-muted-foreground">
            先解析为候选知识，确认内容后再导入现有通用知识库。
          </p>
        </DialogHeader>

        <main className="grid max-h-[calc(92vh-9rem)] gap-5 overflow-y-auto px-6 py-5">
          <section className="grid gap-4 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="grid gap-2">
                <Label htmlFor="knowledge-file">本地文件</Label>
                <Input
                  id="knowledge-file"
                  type="file"
                  accept=".md,.txt,text/markdown,text/plain"
                  disabled={isReadingFile || isParsing || isImporting}
                  onChange={(event) => void handleFileChange(event.target.files?.[0])}
                />
              </div>
              <div className="text-sm text-muted-foreground">
                {file ? `${fileName} · ${(fileSizeBytes / 1024).toFixed(1)} KB` : "仅支持 .md、.txt，最大 10 MB"}
              </div>
            </div>
            {fileWarning ? <p className="text-sm text-amber-600">{fileWarning}</p> : null}
            <div className="grid gap-2">
              <Label>本次可用工单模块</Label>
              <div className="grid max-h-32 gap-2 overflow-auto rounded-md border border-border bg-background p-3 sm:grid-cols-3">
                {moduleOptions.map((item) => (
                  <label key={item.code} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={defaultModules.includes(item.code)}
                      disabled={isReadingFile || isParsing || isImporting || candidates.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked && defaultModules.length >= MAX_MODULES) {
                          setErrorMessage(`模块数量不能超过 ${MAX_MODULES} 个`);
                          return;
                        }
                        setDefaultModules((current) =>
                          checked
                            ? Array.from(new Set([...current, item.code]))
                            : current.filter((code) => code !== item.code),
                        );
                      }}
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="max-w-sm">
              <Label>默认知识类型</Label>
              <Select
                value={defaultCategory}
                disabled={isReadingFile || isParsing || isImporting || candidates.length > 0}
                onValueChange={(value) => setDefaultCategory(value as GeneralKnowledgeCategory)}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="选择知识类型" />
                </SelectTrigger>
                <SelectContent>
                  {GENERAL_KNOWLEDGE_CATEGORY_VALUES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {GENERAL_KNOWLEDGE_CATEGORY_LABELS[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="grid gap-4 rounded-xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">分块设置与预览</h3>
                <p className="text-xs text-muted-foreground">Markdown 标题识别固定开启。</p>
              </div>
              <Button type="button" variant="outline" disabled={isReadingFile || isParsing || isImporting} onClick={handleRechunk}>
                {isParsing ? "解析中" : candidates.length ? "重新分块" : "开始解析"}
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="chunk-size">每条内容长度</Label>
                <Input
                  id="chunk-size"
                  type="number"
                  min={200}
                  max={4000}
                  value={splitOptions.chunkSize}
                  disabled={isParsing || isImporting}
                  onChange={(event) => setSplitOptions((current) => ({ ...current, chunkSize: Number(event.target.value) }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="overlap-ratio">内容重叠（百分比）</Label>
                <Input
                  id="overlap-ratio"
                  type="number"
                  min={0}
                  max={40}
                  value={Math.round(splitOptions.overlapRatio * 100)}
                  disabled={isParsing || isImporting}
                  onChange={(event) => setSplitOptions((current) => ({ ...current, overlapRatio: Number(event.target.value) / 100 }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="max-chunks">最大候选数量</Label>
                <Input
                  id="max-chunks"
                  type="number"
                  min={1}
                  max={100}
                  value={splitOptions.maxChunks}
                  disabled={isParsing || isImporting}
                  onChange={(event) => setSplitOptions((current) => ({ ...current, maxChunks: Number(event.target.value) }))}
                />
              </div>
            </div>
            {candidates.length ? (
              <p className="text-sm text-muted-foreground">已生成 {candidates.length} 条候选知识，请逐条确认。</p>
            ) : null}
          </section>

          <section className="grid gap-4 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">候选审核</h3>
                <p className="text-xs text-muted-foreground">已选 {selectedCount} 条，共 {candidates.length} 条</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={candidates.length > 0 && selectedCount === candidates.length}
                  onCheckedChange={(checked) =>
                    setSelectedCandidateIds(checked ? candidates.map((candidate) => candidate.candidateId) : [])
                  }
                />
                全选
              </label>
            </div>
            <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <div className="grid content-start gap-2">
                {candidates.map((candidate, index) => (
                  <div
                    key={candidate.candidateId}
                    className={`rounded-lg border p-3 text-left ${selectedCandidate?.candidateId === candidate.candidateId ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={selectedCandidateIds.includes(candidate.candidateId)}
                        onCheckedChange={(checked) => toggleCandidate(candidate.candidateId, checked === true)}
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setSelectedCandidateId(candidate.candidateId)}
                      >
                        <span className="block truncate text-sm font-medium">#{index + 1} {candidate.title || "未填写标题"}</span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          <Badge variant="outline">{candidate.indexStatus === "success" ? "索引完成" : candidate.indexStatus === "failed" ? "索引失败" : "索引待处理"}</Badge>
                          <Badge variant={candidate.importStatus === "success" ? "default" : "outline"}>
                            {candidate.importStatus === "success" ? "已导入" : candidate.importStatus === "failed" ? "导入失败" : candidate.importStatus === "skipped" ? "已跳过" : "待导入"}
                          </Badge>
                        </span>
                        {candidate.error ? (
                          <span className="mt-1 block text-xs text-destructive">{candidate.error}</span>
                        ) : null}
                      </button>
                    </div>
                    {candidate.duplicate !== "none" ? (
                      <div className="mt-2 grid gap-2 text-xs text-amber-700">
                        <span>{candidate.duplicate === "current" ? "与当前文件中的其他候选正文重复" : "与已有知识正文重复"}</span>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={candidate.duplicateAction === "skip" ? "default" : "outline"}
                            onClick={() => setCandidates((current) => current.map((item) => item.candidateId === candidate.candidateId ? { ...item, duplicateAction: "skip" as const } : item))}
                          >
                            跳过
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={candidate.duplicateAction === "continue" ? "default" : "outline"}
                            onClick={() => setCandidates((current) => current.map((item) => item.candidateId === candidate.candidateId ? { ...item, duplicateAction: "continue" as const } : item))}
                          >
                            继续导入
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {candidate.indexStatus === "failed" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() => void generateIndexes([candidate])}
                      >
                        重试索引
                      </Button>
                    ) : null}
                    {candidate.importStatus === "failed" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2 ml-2"
                        onClick={() => void handleImport([candidate])}
                      >
                        重试导入
                      </Button>
                    ) : null}
                  </div>
                ))}
                {!candidates.length ? <p className="text-sm text-muted-foreground">解析后将在这里显示候选知识。</p> : null}
              </div>

              <div className="min-w-0">
                {selectedCandidate ? (
                  <>
                    <KnowledgeFieldsEditor
                      value={selectedCandidate}
                      moduleOptions={availableModuleOptions}
                      errors={selectedCandidate.errors}
                      onChange={(value) => setCandidateValues(selectedCandidate.candidateId, value)}
                      showRevision
                      showIndexFields
                      disabled={isImporting || selectedCandidate.importStatus === "success"}
                    />
                    {selectedCandidate.contentModified ? (
                      <p className="mt-3 text-xs text-amber-600">
                        正文已修改，召回索引可能不再匹配。你仍然可以继续导入。
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                    请选择候选知识
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="grid gap-4 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">批量设置和处理状态</h3>
                <p className="text-xs text-muted-foreground">批量设置只作用于当前勾选的候选。</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>待处理 {pendingCount}</span>
                <span>成功 {successCount}</span>
                <span>失败 {failedCount}</span>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_auto]">
              <div className="grid gap-2">
                <Label>批量设置模块</Label>
                <div className="flex max-h-20 flex-wrap gap-x-3 gap-y-2 overflow-auto rounded-md border border-border bg-background p-2">
                  {availableModuleOptions.map((item) => (
                    <label key={item.code} className="flex items-center gap-1 text-xs">
                      <Checkbox
                        checked={bulkModules.includes(item.code)}
                        onCheckedChange={(checked) => setBulkModules((current) => checked ? Array.from(new Set([...current, item.code])) : current.filter((code) => code !== item.code))}
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <Label>批量设置知识类型</Label>
                <Select value={bulkCategory} onValueChange={(value) => setBulkCategory(value as GeneralKnowledgeCategory)}>
                  <SelectTrigger><SelectValue placeholder="不修改" /></SelectTrigger>
                  <SelectContent>
                    {GENERAL_KNOWLEDGE_CATEGORY_VALUES.map((category) => (
                      <SelectItem key={category} value={category}>{GENERAL_KNOWLEDGE_CATEGORY_LABELS[category]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" variant="outline" className="self-end" onClick={applyBulkSettings}>应用</Button>
            </div>
          </section>
        </main>

        <DialogFooter className="sticky bottom-0 border-t border-border bg-background px-6 py-4">
          {errorMessage ? <p className="mr-auto max-w-md text-sm text-destructive">{errorMessage}</p> : null}
          <Button type="button" variant="outline" disabled={isImporting} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" variant="outline" disabled={isParsing || isImporting || !candidates.length} onClick={handleGenerateIndexes}>一键生成索引</Button>
          <Button type="button" disabled={isParsing || isImporting || !candidates.length} onClick={() => void handleImport()}>
            {isImporting ? "导入中" : "确认并导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
