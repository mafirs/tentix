import { StarterKit } from "@tiptap/starter-kit";
import {
  useEditor,
  type Editor,
  type Content,
  type JSONContent,
  type UseEditorOptions,
} from "@tiptap/react";
import { Typography } from "@tiptap/extension-typography";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Underline } from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import {
  Link,
  Image,
  Video,
  VIDEO_MAX_SIZE,
  HorizontalRule,
  CodeBlockLowlight,
  Selection,
  Color,
  UnsetAllMarks,
  FileHandler,
  Attachment,
  ATTACHMENT_MIME_TYPES,
  getAttachmentMaxSize,
  isGenericAttachmentMimeType,
  normalizeGenericAttachmentFile,
  ChatKeyboardExtension,
} from "../extensions/index.ts";
import { cn } from "uisrc/lib/utils.ts";
import {
  getOutput,
  randomId,
  cleanupBlobUrls,
  type FileError,
} from "../utils.ts";
import { useToast } from "uisrc/hooks/use-toast.ts";
import { useEffect, useMemo, useRef, useCallback } from "react";
import { useThrottle } from "./use-throttle.ts";
import i18n from "i18n";

export interface UseMinimalTiptapEditorProps extends UseEditorOptions {
  value?: Content;
  output?: "html" | "json" | "text";
  placeholder?: string;
  editorClassName?: string;
  throttleDelay?: number;
  onUpdate?: (content: Content) => void;
  onBlur?: (content: Content) => void;
  // 🎯 性能选项
  enablePerformanceMode?: boolean;
  isSSR?: boolean;
  editorProps?: any;
}

type FileUploadErrorReason =
  | "type"
  | "size"
  | "invalidBase64"
  | "base64NotAllowed";

const fileUploadErrorMapping: Record<FileUploadErrorReason, string> = {
  type: "attachment_file_type_error",
  size: "attachment_file_size_error",
  invalidBase64: "attachment_file_not_image",
  base64NotAllowed: "attachment_file_not_image",
} as const;

const getFileUploadErrorMessage = (error: FileError): string => {
  if (error.file instanceof File && error.file.type.startsWith("video/")) {
    if (error.reason === "size") {
      const sizeInMb = Math.ceil(error.file.size / (1024 * 1024));
      return i18n.t("attachment_video_size_error", { size: sizeInMb });
    }
    if (error.reason === "type") {
      return i18n.t("attachment_mp4_only");
    }
  }
  return i18n.t(fileUploadErrorMapping[error.reason]);
};

const mergePastedContentWithLocalMedia = (
  pastedContent: JSONContent[] | null,
  mediaNodes: JSONContent[],
) => {
  let imageIndex = 0;

  const replaceImageNode = (node: JSONContent): JSONContent => {
    if (node.type === "image") {
      const imageNode = mediaNodes[imageIndex];
      if (imageNode?.type === "image") {
        imageIndex += 1;
        return imageNode;
      }
    }

    if (!node.content) {
      return node;
    }

    return {
      ...node,
      content: node.content.map(replaceImageNode),
    };
  };

  const content = (pastedContent ?? []).map(replaceImageNode);
  return [...content, ...mediaNodes.slice(imageIndex)];
};

const createExtensions = (
  getPlaceholder: () => string,
  toast: (...args: any[]) => void,
) => [
  StarterKit.configure({
    horizontalRule: false,
    codeBlock: false,
    paragraph: { HTMLAttributes: { class: "text-node" } },
    heading: { HTMLAttributes: { class: "heading-node" } },
    blockquote: { HTMLAttributes: { class: "block-node" } },
    bulletList: { HTMLAttributes: { class: "list-node" } },
    orderedList: { HTMLAttributes: { class: "list-node" } },
    code: { HTMLAttributes: { class: "inline", spellcheck: "false" } },
    dropcursor: { width: 2, class: "ProseMirror-dropcursor border" },
  }),
  ChatKeyboardExtension,
  Link,
  Underline,

  // 🎯 优化的图片配置
  Image.configure({
    allowedMimeTypes: [
      "image/*",
      "application/*",
      "video/*",
      "text/*",
      "audio/*",
    ],
    maxFileSize: 5 * 1024 * 1024,
    onValidationError(errors) {
      toast({
        title: i18n.t("image_validation_error"),
        description: errors
          .map(getFileUploadErrorMessage)
          .join(", "),
        variant: "destructive",
      });
    },
  }),
  Video.configure({
    allowedMimeTypes: ["video/mp4"],
    maxFileSize: VIDEO_MAX_SIZE,
    onValidationError(errors) {
      toast({
        title: i18n.t("video_validation_error"),
        description: errors.map(getFileUploadErrorMessage).join(", "),
        variant: "destructive",
      });
    },
  }),
  Attachment.configure({
    allowedMimeTypes: [...ATTACHMENT_MIME_TYPES],
    maxFileSize: getAttachmentMaxSize,
    onValidationError: (errors) => toast({
      title: i18n.t("file_validation_error"),
      description: errors.map(getFileUploadErrorMessage).join(", "),
      variant: "destructive",
    }),
    onLimitError: ({ key, params }) => toast({
      title: i18n.t("attachment_limit_exceeded"),
      description: i18n.t(key, params),
      variant: "destructive",
    }),
  }),

  // 🎯 优化的文件处理器
  FileHandler.configure({
    allowBase64: false,
    normalizeFile: normalizeGenericAttachmentFile,
    allowedMimeTypes: [
      "image/*",
      ...ATTACHMENT_MIME_TYPES,
      "video/mp4",
    ],
    maxFileSize: (mimeType) =>
      mimeType === "video/mp4"
        ? VIDEO_MAX_SIZE
        : isGenericAttachmentMimeType(mimeType)
          ? getAttachmentMaxSize(mimeType)
          : 5 * 1024 * 1024,
    onDrop: (editor, files, pos) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      const videoFiles = files.filter((file) => file.type === "video/mp4");
      const attachmentFiles = files.filter((file) => isGenericAttachmentMimeType(file.type));

      if (imageFiles.length > 0) {
        const imageNodes = imageFiles.map((file) => ({
          type: "image",
          attrs: {
            id: randomId(),
            src: URL.createObjectURL(file),
            alt: file.name,
            title: file.name,
            fileName: file.name,
            isLocalFile: true,
            originalFile: file,
          },
        }));

        editor.commands.insertContentAt(pos, [
          ...imageNodes,
          { type: "paragraph" },
        ]);
      }

      if (videoFiles.length > 0) {
        editor.commands.insertContentAt(pos, [
          ...videoFiles.map((file) => ({
          type: "video",
          attrs: {
            id: randomId(),
            src: URL.createObjectURL(file),
            title: file.name,
            fileName: file.name,
            isLocalFile: true,
            originalFile: file,
          },
          })),
          { type: "paragraph" },
        ]);
      }
      if (attachmentFiles.length > 0) {
        editor.commands.setAttachments(attachmentFiles, pos ?? 0);
      }
    },
    onPaste: (editor, files, pasteSlice) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      const videoFiles = files.filter((file) => file.type === "video/mp4");
      const attachmentFiles = files.filter((file) => isGenericAttachmentMimeType(file.type));
      const mediaFiles = [...imageFiles, ...videoFiles];

      if (mediaFiles.length === 0 && attachmentFiles.length === 0) {
        return false;
      }

      const mediaNodes = mediaFiles.map((file) => {
        const blobUrl = URL.createObjectURL(file);
        const id = randomId();

        return {
          type: file.type === "video/mp4" ? "video" : "image",
          attrs: {
            id,
            src: blobUrl,
            ...(file.type === "video/mp4" ? {} : { alt: file.name }),
            title: file.name,
            fileName: file.name,
            isLocalFile: true,
            originalFile: file,
          },
        };
      });

      const pastedContent = mergePastedContentWithLocalMedia(
        pasteSlice.content.toJSON(),
        mediaNodes,
      );

      editor.commands.insertContent([...pastedContent, { type: "paragraph" }]);
      if (attachmentFiles.length > 0) {
        editor.commands.setAttachments(attachmentFiles);
      }
      return true;
    },
    onValidationError: (errors) => {
      toast({
        title: i18n.t("file_validation_error"),
        description: errors
          .map(getFileUploadErrorMessage)
          .join(", "),
        variant: "destructive",
      });
    },
  }),

  Color,
  TextStyle,
  Selection,
  Typography,
  UnsetAllMarks,
  HorizontalRule,
  CodeBlockLowlight,
  Placeholder.configure({ placeholder: getPlaceholder }),
];

export const useMinimalTiptapEditor = ({
  value,
  output = "json",
  placeholder = "",
  editorClassName,
  throttleDelay = 0,
  onUpdate,
  onBlur,
  enablePerformanceMode = true,
  isSSR = false,
  editorProps: externalEditorProps,
  ...props
}: UseMinimalTiptapEditorProps) => {
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const { toast } = useToast();

  // 🎯 使用 useRef 避免闭包问题
  const onUpdateRef = useRef(onUpdate);
  const onBlurRef = useRef(onBlur);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
    onBlurRef.current = onBlur;
  }, [onUpdate, onBlur]);

  // 🎯 改进的节流处理 - 确保最后一次调用不会丢失
  const throttledUpdate = useThrottle(
    useCallback((content: Content) => {
      onUpdateRef.current?.(content);
    }, []),
    throttleDelay,
  );

  // 🎯 优化事件处理器 - 统一使用节流逻辑
  const handleUpdate = useCallback(
    (editor: Editor) => {
      const content = getOutput(editor, output);
      throttledUpdate(content);
    },
    [output, throttledUpdate],
  );

  const handleCreate = useCallback(
    (editor: Editor) => {
      if (value && editor.isEmpty) {
        editor.commands.setContent(value);
      }
    },
    [value],
  );

  const handleBlur = useCallback(
    (editor: Editor) => {
      const content = getOutput(editor, output);
      // 失焦时立即调用，不使用节流
      onBlurRef.current?.(content);
    },
    [output],
  );

  const editorConfig = useMemo(() => {
    // 🔥 合并内部和外部的 editorProps
    const mergedEditorProps = {
      attributes: {
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        class: cn("focus:outline-hidden", editorClassName),
        // 如果外部有 attributes，会合并
        ...externalEditorProps?.attributes,
      },
      // 合并其他 editorProps（如 handleKeyDown）
      ...externalEditorProps,
    };

    const baseConfig: UseEditorOptions = {
      extensions: createExtensions(() => placeholderRef.current, toast),
      editorProps: mergedEditorProps, // 🔥 使用合并后的 editorProps
      onUpdate: ({ editor }: { editor: Editor }) => handleUpdate(editor),
      onCreate: ({ editor }: { editor: Editor }) => handleCreate(editor),
      onBlur: ({ editor }: { editor: Editor }) => handleBlur(editor),
      onDestroy: () => {
        // TipTap 的 onDestroy 不提供 editor 参数
        // Blob URL 清理移到 useEffect 中处理
      },

      ...props,
    };

    // 🚀 条件性添加性能优化选项
    if (enablePerformanceMode) {
      const performanceConfig = {
        ...baseConfig,
        immediatelyRender: !isSSR,
        shouldRerenderOnTransaction: false, // 🎯 关键性能优化
      };
      return performanceConfig;
    }

    return baseConfig;
  }, [
    toast,
    enablePerformanceMode,
    isSSR,
    editorClassName,
    handleUpdate,
    handleCreate,
    handleBlur,
    externalEditorProps,
    props,
  ]);

  const editor = useEditor(editorConfig);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta("i18n", true));
  }, [editor, placeholder]);

  // 🎯 处理组件卸载时的 Blob URL 清理
  useEffect(() => {
    return () => {
      // 使用统一的清理函数，防止内存泄漏
      cleanupBlobUrls(editor);
    };
  }, [editor]);

  return editor;
};

export default useMinimalTiptapEditor;
