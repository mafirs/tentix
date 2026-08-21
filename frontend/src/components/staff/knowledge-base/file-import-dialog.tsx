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
type ChunkSettingMode = "auto" | "custom";
type ChunkSplitMode = "paragraph";
type FileImportStep = "file" | "settings" | "preview" | "confirm";

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
  const [activeStep, setActiveStep] = useState<FileImportStep>("file");
  const [splitOptions, setSplitOptions] = useState<{
    chunkSettingMode: ChunkSettingMode;
    chunkSplitMode: ChunkSplitMode;
    paragraphChunkDeep: number;
    chunkSize: number;
  }>({
    chunkSettingMode: "auto",
    chunkSplitMode: "paragraph",
    paragraphChunkDeep: 3,
    chunkSize: 1000,
  });
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const selectedCandidate =
    candidates.find((item) => item.candidateId === selectedCandidateId) ??
    candidates[0] ??
    null;
  const availableModuleOptions = [...moduleOptions].sort(
    (left, right) =>
      Number(defaultModules.includes(right.code)) -
      Number(defaultModules.includes(left.code)),
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
      setErrorMessage("请先选择默认工单模块");
      return;
    }
    if (!defaultCategory) {
      setErrorMessage("请先选择默认知识类型");
      return;
    }
    if (splitOptions.chunkSettingMode === "custom") {
      if (
        !Number.isInteger(splitOptions.chunkSize) ||
        splitOptions.chunkSize < 64 ||
        splitOptions.chunkSize > 4000
      ) {
        setErrorMessage("自定义分块长度必须在 64 到 4000 之间");
        return;
      }
      if (
        !Number.isInteger(splitOptions.paragraphChunkDeep) ||
        splitOptions.paragraphChunkDeep < 1 ||
        splitOptions.paragraphChunkDeep > 8
      ) {
        setErrorMessage("标题识别层级必须在 H1 到 H8 之间");
        return;
      }
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
            chunkSettingMode: splitOptions.chunkSettingMode,
            chunkSplitMode: splitOptions.chunkSplitMode,
            paragraphChunkDeep: splitOptions.paragraphChunkDeep,
            chunkSize: splitOptions.chunkSize,
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
        modules: [...defaultModules],
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
      if (!candidatesWithDuplicates.length) {
        throw new Error("没有解析出可导入的知识，请检查文件内容或调整标题深度");
      }

      setCandidates(candidatesWithDuplicates);
      setSelectedCandidateIds(candidatesWithDuplicates.map((candidate) => candidate.candidateId));
      setSelectedCandidateId(candidatesWithDuplicates[0]?.candidateId ?? "");
      setActiveStep("preview");
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

  const goToSettings = () => {
    if (!file || isReadingFile) {
      setErrorMessage("请先选择并读取文件");
      return;
    }
    setErrorMessage("");
    setActiveStep("settings");
  };

  const goToConfirm = () => {
    const selected = candidates.filter((candidate) =>
      selectedCandidateIds.includes(candidate.candidateId),
    );
    if (!selected.length) {
      setErrorMessage("请至少选择一条候选知识");
      return;
    }
    if (selected.some((candidate) => Boolean(validateCandidate(candidate)))) {
      setErrorMessage("请先修正已选候选中的必填内容");
      return;
    }
    setErrorMessage("");
    setActiveStep("confirm");
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
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] h-[min(900px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))] sm:max-w-[1180px] overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <div className="flex items-center justify-between gap-4 pr-8">
            <div>
              <DialogTitle>导入知识库文件</DialogTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                选择文件，调整分块方式，逐条确认后写入现有通用知识库。
              </p>
            </div>
            <div className="hidden text-right text-xs text-muted-foreground sm:block">
              <p>{file ? fileName : "尚未选择文件"}</p>
              <p className="mt-1">
                {candidates.length ? `${selectedCount}/${candidates.length} 条候选已选` : "等待解析"}
              </p>
            </div>
          </div>
          <nav aria-label="文件导入步骤" className="grid grid-cols-4 gap-2 pt-4">
            {([
              ["file", "选择文件"],
              ["settings", "参数设置"],
              ["preview", "数据预览"],
              ["confirm", "确认导入"],
            ] as const).map(([step, label], index) => (
              <button
                key={step}
                type="button"
                className={`border-t-2 px-1 pt-2 text-left text-xs ${activeStep === step ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
                onClick={() => {
                  if (
                    step === "file" ||
                    (step === "settings" && file) ||
                    (step === "preview" && candidates.length) ||
                    (step === "confirm" && candidates.length)
                  ) {
                    setActiveStep(step);
                  }
                }}
              >
                <span className="mr-1">{index + 1}.</span>{label}
              </button>
            ))}
          </nav>
        </DialogHeader>

        <main className="min-h-0 overflow-y-auto px-6 py-5">
          {activeStep === "file" ? (
            <section className="mx-auto grid max-w-4xl gap-5">
              <div className="grid gap-4 rounded-xl border border-border bg-muted/20 p-5">
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
                    {file
                      ? `${fileName} · ${(fileSizeBytes / 1024).toFixed(1)} KB`
                      : "仅支持 .md、.txt，最大 10 MB"}
                  </div>
                </div>
                {fileWarning ? <p className="text-sm text-amber-600">{fileWarning}</p> : null}
                <div className="grid gap-2">
                  <Label>默认工单模块</Label>
                  <div className="grid max-h-52 gap-2 overflow-auto rounded-md border border-border bg-background p-3 sm:grid-cols-2">
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
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  disabled={!file || isReadingFile || isParsing || isImporting}
                  onClick={goToSettings}
                >
                  下一步：参数设置
                </Button>
              </div>
            </section>
          ) : null}

          {activeStep === "settings" ? (
            <section className="mx-auto grid max-w-4xl gap-5">
              <div className="rounded-xl border border-border bg-muted/20 p-5">
                <h3 className="text-base font-semibold">选择分块方式</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  默认参数适合大多数 Markdown 文件。需要改变标题层级或单段长度时才选择自定义参数。
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {([
                    ["auto", "默认参数", "按 Markdown 标题和自然段落处理，系统自动选择长度和重叠方式。"],
                    ["custom", "自定义参数", "只在文件结构特殊时选择标题深度或单段长度。"],
                  ] as const).map(([mode, title, description]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`rounded-lg border p-4 text-left ${splitOptions.chunkSettingMode === mode ? "border-primary bg-primary/5" : "border-border"}`}
                      onClick={() => setSplitOptions((current) => ({ ...current, chunkSettingMode: mode }))}
                    >
                      <p className="font-medium">{title}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    </button>
                  ))}
                </div>
              </div>
              {splitOptions.chunkSettingMode === "custom" ? (
                <div className="grid gap-4 rounded-xl border border-border p-5">
                  <div className="grid gap-2">
                    <p className="text-sm font-medium">按段落和标题</p>
                    <p className="text-xs text-muted-foreground">
                      候选标题使用当前标题；父级标题只作为正文上下文。
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>识别到第几级标题</Label>
                      <Select
                        value={String(splitOptions.paragraphChunkDeep)}
                        onValueChange={(value) =>
                          setSplitOptions((current) => ({ ...current, paragraphChunkDeep: Number(value) }))
                        }
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5, 6, 7, 8].map((level) => (
                            <SelectItem key={level} value={String(level)}>
                              识别到 H{level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">更深的标题会留在当前知识正文里。</p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="chunk-size">单条内容长度</Label>
                      <Input
                        id="chunk-size"
                        type="number"
                        min={64}
                        max={4000}
                        step={100}
                        value={splitOptions.chunkSize}
                        disabled={isParsing || isImporting}
                        onChange={(event) =>
                          setSplitOptions((current) => ({ ...current, chunkSize: Number(event.target.value) }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">内容超过这个长度时，系统会按段落和标点继续处理。</p>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <Button type="button" variant="outline" onClick={() => setActiveStep("file")}>上一步</Button>
                <Button type="button" disabled={isParsing || isImporting} onClick={handleRechunk}>
                  {isParsing ? "解析中" : "生成预览"}
                </Button>
              </div>
            </section>
          ) : null}

          {activeStep === "preview" ? (
            <section className="grid min-h-0 gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">候选知识审核</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    每条候选都可以修改标题、正文、模块、知识类型和索引。
                  </p>
                </div>
                <div className="flex gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">已选 {selectedCount}</Badge>
                  <Badge variant="outline">共 {candidates.length}</Badge>
                  <Badge variant="outline">最多 100 条</Badge>
                </div>
              </div>
              <div className="grid gap-4 lg:h-[min(32rem,calc(100vh-24rem))] lg:min-h-0 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
                <div className="grid min-h-0 min-w-0 content-start gap-2 overflow-hidden rounded-lg border border-border bg-muted/20 p-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={candidates.length > 0 && selectedCount === candidates.length}
                      onCheckedChange={(checked) =>
                        setSelectedCandidateIds(checked ? candidates.map((candidate) => candidate.candidateId) : [])
                      }
                    />
                    全选候选
                  </label>
                  <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
                    {candidates.map((candidate, index) => (
                      <div
                        key={candidate.candidateId}
                        className={`min-w-0 rounded-lg border p-3 text-left ${selectedCandidate?.candidateId === candidate.candidateId ? "border-primary bg-primary/5" : "border-border bg-background"}`}
                      >
                        <div className="flex min-w-0 items-start gap-2">
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
                            {candidate.error ? <span className="mt-1 block text-xs text-destructive">{candidate.error}</span> : null}
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
                          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void generateIndexes([candidate])}>重试索引</Button>
                        ) : null}
                        {candidate.importStatus === "failed" ? (
                          <Button type="button" size="sm" variant="outline" className="mt-2 ml-2" onClick={() => void handleImport([candidate])}>重试导入</Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="min-h-0 min-w-0 overflow-y-auto pr-1">
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
                        <p className="mt-3 text-xs text-amber-600">正文已修改，召回索引可能不再匹配。你仍然可以继续导入。</p>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">请选择候选知识</div>
                  )}
                </div>
              </div>
              <section className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4">
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
              <div className="flex justify-between gap-3">
                <Button type="button" variant="outline" onClick={() => setActiveStep("settings")}>返回参数设置</Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" disabled={isParsing || isImporting || !candidates.length} onClick={handleGenerateIndexes}>一键生成索引</Button>
                  <Button type="button" disabled={isParsing || isImporting} onClick={goToConfirm}>下一步：确认导入</Button>
                </div>
              </div>
            </section>
          ) : null}

          {activeStep === "confirm" ? (
            <section className="mx-auto grid max-w-3xl gap-5">
              <div className="rounded-xl border border-border bg-muted/20 p-5">
                <h3 className="text-base font-semibold">确认导入</h3>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">文件</dt><dd className="mt-1 break-all">{fileName}</dd></div>
                  <div><dt className="text-muted-foreground">候选数量</dt><dd className="mt-1">{selectedCount} 条</dd></div>
                  <div><dt className="text-muted-foreground">索引状态</dt><dd className="mt-1">已生成 {candidates.filter((candidate) => candidate.indexStatus === "success").length} 条，未生成也可以导入</dd></div>
                  <div><dt className="text-muted-foreground">失败状态</dt><dd className="mt-1">{failedCount ? `${failedCount} 条失败，可返回重试` : "没有失败项"}</dd></div>
                </dl>
              </div>
              <div className="flex justify-between gap-3">
                <Button type="button" variant="outline" disabled={isImporting} onClick={() => setActiveStep("preview")}>返回审核</Button>
                <Button type="button" disabled={isImporting} onClick={() => void handleImport()}>{isImporting ? "导入中" : "确认并导入选中内容"}</Button>
              </div>
            </section>
          ) : null}
        </main>

        <DialogFooter className="border-t border-border bg-background px-6 py-4">
          {errorMessage ? <p role="alert" className="mr-auto max-w-xl text-sm text-destructive">{errorMessage}</p> : null}
          <Button type="button" variant="outline" disabled={isImporting} onClick={() => onOpenChange(false)}>取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
