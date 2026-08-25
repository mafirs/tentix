import type { Editor } from "@tiptap/react";
import type { VariantProps } from "class-variance-authority";
import { useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "i18n";
import {
  FileTextIcon,
  ImageIcon,
  PaperclipIcon,
  UploadIcon,
  VideoIcon,
} from "lucide-react";
import { ToolbarButton } from "../toolbar-button.tsx";
import { ATTACHMENT_ACCEPT } from "../../extensions/attachment/index.ts";
import type { toggleVariants } from "../../../ui/toggle.tsx";
import { Button } from "../../../ui/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../ui/popover.tsx";

interface AttachmentEditDialogProps extends VariantProps<typeof toggleVariants> {
  editor: Editor;
}

export const AttachmentEditDialog = ({
  editor,
  size,
  variant,
}: AttachmentEditDialogProps) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  const handleSelectFiles = () => {
    inputRef.current?.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      editor.commands.setUploadFiles(files);
      setOpen(false);
    }
    event.target.value = "";
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <ToolbarButton
            tooltip="Upload file"
            aria-label="Upload file"
            size={size}
            variant={variant}
          >
            <PaperclipIcon className="size-5" />
          </ToolbarButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          className="w-[min(22rem,calc(100vw-2rem))] p-0"
        >
          <div className="p-4">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <PaperclipIcon className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("attachment_supported_files")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("attachment_input_hint")}</p>
              </div>
            </div>
            <div className="space-y-3 text-xs">
              <div className="flex gap-3">
                <ImageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium">{t("attachment_images")}</p>
                  <p className="mt-1 text-muted-foreground">{t("attachment_image_limit")}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <VideoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium">{t("attachment_videos")}</p>
                  <p className="mt-1 text-muted-foreground">{t("attachment_video_limit")}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="font-medium">{t("attachment_generic_files")}</p>
                  <p className="mt-1 break-words text-muted-foreground">{t("attachment_generic_formats")}</p>
                  <p className="mt-1 text-muted-foreground">{t("attachment_generic_size_limit")}</p>
                </div>
              </div>
            </div>
            <div className="mt-4 border-t pt-3">
              <p className="mb-3 text-xs text-muted-foreground">{t("attachment_message_limit", { count: 5, size: "50 MB" })}</p>
              <Button type="button" className="w-full" onClick={handleSelectFiles}>
                <UploadIcon className="size-4" />
                {t("attachment_choose_file")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <input
        ref={inputRef}
        type="file"
        accept={`image/*,${ATTACHMENT_ACCEPT},video/mp4`}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
    </>
  );
};
