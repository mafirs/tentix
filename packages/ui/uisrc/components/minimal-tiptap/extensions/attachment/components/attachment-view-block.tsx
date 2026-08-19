import { FileTextIcon } from "lucide-react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

export const AttachmentViewBlock = ({ node }: NodeViewProps) => (
  <NodeViewWrapper className="attachment-node flex items-center gap-2">
    <FileTextIcon className="size-5" />
    <span>{String(node.attrs.fileName || "attachment")}</span>
    <span>{String(node.attrs.mimeType || "")}</span>
    <span>{String(node.attrs.fileSize || 0)} B</span>
  </NodeViewWrapper>
);
