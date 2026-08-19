import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { filterFiles, randomId, type FileError, type FileValidationOptions } from "../../utils.ts";
import { AttachmentViewBlock } from "./components/attachment-view-block.tsx";

export const ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
] as const;
export const ATTACHMENT_ACCEPT = ".pdf,.docx,.xlsx,.csv,.pptx,.txt,.json,.xml";
export const ATTACHMENT_MAX_SIZE = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 5;
export const ATTACHMENT_MAX_TOTAL_SIZE = 50 * 1024 * 1024;

export function isGenericAttachmentMimeType(fileType: string): boolean {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(fileType);
}

interface AttachmentOptions extends Omit<FileValidationOptions, "allowBase64"> {
  onValidationError?: (errors: FileError[]) => void;
  onLimitError?: (message: string) => void;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    customAttachment: {
      setAttachments: (files: File[], position?: number) => ReturnType;
      toggleAttachment: () => ReturnType;
    };
  }
}

export const Attachment = Node.create<AttachmentOptions>({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  addOptions: () => ({
    allowedMimeTypes: [...ATTACHMENT_MIME_TYPES],
    maxFileSize: ATTACHMENT_MAX_SIZE,
  }),
  addAttributes: () => ({
    src: { default: null, rendered: false },
    fileName: { default: null },
    mimeType: { default: null },
    fileSize: { default: null },
    storageFileName: { default: null, rendered: false },
    id: { default: null },
    isLocalFile: { default: false, rendered: false },
    originalFile: { default: null, rendered: false },
  }),
  addCommands() {
    return {
      setAttachments: (files, position) => ({ editor, commands }) => {
        const [validFiles, errors] = filterFiles(files, {
          allowedMimeTypes: this.options.allowedMimeTypes,
          maxFileSize: this.options.maxFileSize,
          allowBase64: false,
        });
        if (errors.length > 0) {
          this.options.onValidationError?.(errors);
        }
        const current = editor.getJSON().content ?? [];
        const currentAttachments = collectAttachmentNodes(current, this.name);
        const currentSize = currentAttachments.reduce(
          (total, node) => total + Number(node.attrs?.fileSize ?? 0),
          0,
        );
        const incomingSize = validFiles.reduce((total, file) => total + file.size, 0);
        if (currentAttachments.length + validFiles.length > ATTACHMENT_MAX_COUNT) {
          this.options.onLimitError?.("单条消息最多添加 5 个附件");
          return false;
        }
        if (currentSize + incomingSize > ATTACHMENT_MAX_TOTAL_SIZE) {
          this.options.onLimitError?.("单条消息附件总大小不能超过 50 MB");
          return false;
        }
        if (validFiles.length === 0) return false;
        return commands.insertContentAt(position ?? editor.state.selection.from, [
          ...validFiles.map((file) => ({
            type: this.name,
            attrs: {
              id: randomId(),
              src: URL.createObjectURL(file),
              fileName: file.name,
              mimeType: file.type,
              fileSize: file.size,
              isLocalFile: true,
              originalFile: file,
            },
          })),
          { type: "paragraph" },
        ]);
      },
      toggleAttachment: () => ({ editor }) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ATTACHMENT_ACCEPT;
        input.multiple = true;
        input.onchange = () => {
          if (input.files?.length) editor.commands.setAttachments(Array.from(input.files));
        };
        input.click();
        return true;
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentViewBlock, { className: "block-node" });
  },
});

function collectAttachmentNodes(
  nodes: Array<{ type?: string; attrs?: Record<string, unknown>; content?: unknown[] }>,
  type: string,
): Array<{ type?: string; attrs?: Record<string, unknown> }> {
  return nodes.flatMap((node) => [
    ...(node.type === type ? [node] : []),
    ...(Array.isArray(node.content)
      ? collectAttachmentNodes(
          node.content as Array<{ type?: string; attrs?: Record<string, unknown>; content?: unknown[] }>,
          type,
        )
      : []),
  ]);
}
