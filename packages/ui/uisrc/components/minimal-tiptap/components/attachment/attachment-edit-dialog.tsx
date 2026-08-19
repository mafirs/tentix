import type { Editor } from "@tiptap/react";
import type { VariantProps } from "class-variance-authority";
import { useRef } from "react";
import { PaperclipIcon } from "lucide-react";
import { ToolbarButton } from "../toolbar-button.tsx";
import { ATTACHMENT_ACCEPT } from "../../extensions/attachment/index.ts";
import type { toggleVariants } from "../../../ui/toggle.tsx";

interface AttachmentEditDialogProps extends VariantProps<typeof toggleVariants> {
  editor: Editor;
}

export const AttachmentEditDialog = ({
  editor,
  size,
  variant,
}: AttachmentEditDialogProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <ToolbarButton
        tooltip="Upload file"
        aria-label="Upload file"
        size={size}
        variant={variant}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon className="size-5" />
      </ToolbarButton>
      <input
        ref={inputRef}
        type="file"
        accept={`${ATTACHMENT_ACCEPT},video/mp4`}
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) {
            editor.commands.setUploadFiles(Array.from(event.target.files));
          }
          event.target.value = "";
        }}
      />
    </>
  );
};
