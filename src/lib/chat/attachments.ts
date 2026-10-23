export type AttachmentRecord = {
  id: string;
  name: string;
  status: "PROCESSING" | "READY" | "PARTIAL" | "FAILED";
  kind: "TEXT" | "IMAGE";
  ocrText: string | null;
};

export type AttachmentIssue = {
  code: "DOCUMENT_PROCESSING" | "DOCUMENT_FAILED" | "DOCUMENT_NO_TEXT";
  message: string;
  status: number;
};

/**
 * 附件进入检索前的可用性校验。
 *
 * 返回第一个问题；全部可用时返回 null。
 * 顺序：处理中 → 失败 → 图片无 OCR 文本。
 */
export function findAttachmentIssue(
  attachments: readonly AttachmentRecord[],
): AttachmentIssue | null {
  const processing = attachments.find((doc) => doc.status === "PROCESSING");
  if (processing) {
    return {
      code: "DOCUMENT_PROCESSING",
      message: `资料「${processing.name}」仍在处理中，请稍后再试。`,
      status: 409,
    };
  }

  const failed = attachments.find((doc) => doc.status === "FAILED");
  if (failed) {
    return {
      code: "DOCUMENT_FAILED",
      message: `资料「${failed.name}」处理失败，请重新上传或重试。`,
      status: 422,
    };
  }

  const imageWithoutText = attachments.find(
    (doc) => doc.kind === "IMAGE" && !doc.ocrText?.trim(),
  );
  if (imageWithoutText) {
    return {
      code: "DOCUMENT_NO_TEXT",
      message: `图片「${imageWithoutText.name}」没有识别到可用文字。`,
      status: 422,
    };
  }

  return null;
}
