import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "tentix-ui";
import { useId } from "react";

export const GENERAL_KNOWLEDGE_CATEGORY_VALUES = [
  "troubleshooting",
  "feature",
  "billing",
  "operation",
  "other",
] as const;

export const GENERAL_KNOWLEDGE_CATEGORY_LABELS: Record<
  (typeof GENERAL_KNOWLEDGE_CATEGORY_VALUES)[number],
  string
> = {
  troubleshooting: "故障排查",
  feature: "功能说明",
  billing: "费用计费",
  operation: "运营规则",
  other: "其他",
};

export type GeneralKnowledgeCategory =
  (typeof GENERAL_KNOWLEDGE_CATEGORY_VALUES)[number];

export type KnowledgeFieldValues = {
  title: string;
  content: string;
  modules: string[];
  category: GeneralKnowledgeCategory | "";
  revision: string;
  indexes: string[];
};

export type KnowledgeFieldErrors = {
  title?: string;
  modules?: string;
  category?: string;
  revision?: string;
  content?: string;
  indexes?: Array<string | undefined>;
};

export type KnowledgeFieldsEditorProps = {
  value: KnowledgeFieldValues;
  moduleOptions: Array<{ code: string; label: string }>;
  onChange: (value: KnowledgeFieldValues) => void;
  errors?: KnowledgeFieldErrors;
  showRevision?: boolean;
  showIndexFields?: boolean;
  showIndexGenerationControls?: boolean;
  autoGenerateIndexes?: boolean;
  onAutoGenerateIndexesChange?: (checked: boolean) => void;
  onGenerateIndexes?: () => void;
  indexGenerationPending?: boolean;
  disabled?: boolean;
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export function KnowledgeFieldsEditor({
  value,
  moduleOptions,
  onChange,
  errors,
  showRevision = true,
  showIndexFields = true,
  showIndexGenerationControls = false,
  autoGenerateIndexes = false,
  onAutoGenerateIndexesChange,
  onGenerateIndexes,
  indexGenerationPending = false,
  disabled = false,
}: KnowledgeFieldsEditorProps) {
  const fieldId = useId();
  const update = (next: Partial<KnowledgeFieldValues>) => {
    onChange({ ...value, ...next });
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${fieldId}-title`}>标题</Label>
          <span className="text-xs text-muted-foreground">用于列表显示和召回结果标题</span>
        </div>
        <Input
          id={`${fieldId}-title`}
          value={value.title}
          disabled={disabled}
          placeholder="例如：账号登录失败"
          onChange={(event) => update({ title: event.target.value })}
        />
        <FieldError message={errors?.title} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.8fr)]">
        <div className="grid gap-2">
          <Label>正文</Label>
          <Textarea
            value={value.content}
            disabled={disabled}
            placeholder="填写会返回给 AI 的正式知识内容"
            className="min-h-[360px] max-w-full [field-sizing:fixed] [overflow-wrap:anywhere] [word-break:break-word]"
            onChange={(event) => update({ content: event.target.value })}
          />
          <FieldError message={errors?.content} />
        </div>

        <div className="grid content-start gap-4 rounded-lg border border-border bg-muted/20 p-4">
          <div className="grid gap-2">
            <Label>适用模块</Label>
            <div className="grid max-h-52 gap-2 overflow-auto rounded-md border border-border bg-background p-3">
              {moduleOptions.length ? (
                moduleOptions.map((item) => (
                  <label key={item.code} className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={value.modules.includes(item.code)}
                      disabled={disabled}
                      onCheckedChange={(checked) => {
                        const modules = checked
                          ? Array.from(new Set([...value.modules, item.code]))
                          : value.modules.filter((module) => module !== item.code);
                        update({ modules });
                      }}
                    />
                    <span className="min-w-0">{item.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.code}</span>
                  </label>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">暂无可选模块</span>
              )}
            </div>
            <FieldError message={errors?.modules} />
          </div>

          <div className="grid gap-2">
            <Label>知识类型</Label>
            <Select
              value={value.category}
              disabled={disabled}
              onValueChange={(category) =>
                update({ category: category as GeneralKnowledgeCategory })
              }
            >
              <SelectTrigger>
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
            <FieldError message={errors?.category} />
          </div>

          {showRevision ? (
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-revision`}>版本</Label>
              <Input
                id={`${fieldId}-revision`}
                value={value.revision}
                disabled={disabled}
                placeholder="例如：manual-2026-08-20"
                onChange={(event) => update({ revision: event.target.value })}
              />
              <FieldError message={errors?.revision} />
            </div>
          ) : null}
        </div>
      </div>

      {showIndexFields ? (
        <div className="grid gap-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">召回索引</p>
              <p className="text-xs text-muted-foreground">最多填写三条，可留空</p>
            </div>
            {showIndexGenerationControls ? (
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={autoGenerateIndexes}
                    disabled={disabled || indexGenerationPending}
                    onCheckedChange={(checked) =>
                      onAutoGenerateIndexesChange?.(checked === true)
                    }
                  />
                  自动生成
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    disabled ||
                    !autoGenerateIndexes ||
                    indexGenerationPending
                  }
                  onClick={onGenerateIndexes}
                >
                  {indexGenerationPending ? "生成中" : "生成索引"}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="grid gap-2">
                <Label htmlFor={`${fieldId}-index-${index}`}>
                  召回索引 {index + 1}
                </Label>
                <Input
                  id={`${fieldId}-index-${index}`}
                  value={value.indexes[index] ?? ""}
                  disabled={disabled}
                  placeholder="用户可能的问法，可留空"
                  onChange={(event) => {
                    const indexes = [...value.indexes];
                    indexes[index] = event.target.value;
                    update({ indexes });
                  }}
                />
                <FieldError message={errors?.indexes?.[index]} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
