export const GENERIC_ATTACHMENT_MAX_SIZE = 25 * 1024 * 1024;
export const GENERIC_ATTACHMENT_MAX_COUNT = 5;
export const GENERIC_ATTACHMENT_MAX_TOTAL_SIZE = 50 * 1024 * 1024;

export const GENERIC_ATTACHMENT_MIME_TYPES = {
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv", "application/vnd.ms-excel"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  txt: ["text/plain"],
  json: ["application/json"],
  xml: ["application/xml", "text/xml"],
} as const;

export const GENERIC_ATTACHMENT_MIME_SET: Set<string> = new Set(
  Object.values(GENERIC_ATTACHMENT_MIME_TYPES).flat(),
);

export function getGenericAttachmentExtension(fileName: string): string | null {
  const extension = fileName.toLowerCase().split(".").pop();
  return extension && extension in GENERIC_ATTACHMENT_MIME_TYPES ? extension : null;
}

export function isGenericAttachmentMimeType(fileType: string): boolean {
  return GENERIC_ATTACHMENT_MIME_SET.has(fileType);
}

export function isGenericAttachmentPair(
  fileName: string,
  fileType: string,
): boolean {
  const extension = getGenericAttachmentExtension(fileName);
  return extension !== null &&
    (GENERIC_ATTACHMENT_MIME_TYPES[extension as keyof typeof GENERIC_ATTACHMENT_MIME_TYPES] as readonly string[]).includes(fileType);
}
