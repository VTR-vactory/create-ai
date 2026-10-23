import { describe, expect, it } from "vitest";
import { findAttachmentIssue, type AttachmentRecord } from "./attachments";

const readyText: AttachmentRecord = {
  id: "doc-1",
  name: "notes.md",
  status: "READY",
  kind: "TEXT",
  ocrText: null,
};

const readyImage: AttachmentRecord = {
  id: "doc-2",
  name: "receipt.png",
  status: "READY",
  kind: "IMAGE",
  ocrText: "退款周期：14 个工作日",
};

describe("findAttachmentIssue", () => {
  it("没有附件时返回 null", () => {
    expect(findAttachmentIssue([])).toBeNull();
  });

  it("处理中的附件返回 409", () => {
    expect(
      findAttachmentIssue([{ ...readyImage, status: "PROCESSING" }]),
    ).toMatchObject({ code: "DOCUMENT_PROCESSING", status: 409 });
  });

  it("失败的附件返回 422", () => {
    expect(
      findAttachmentIssue([{ ...readyText, status: "FAILED" }]),
    ).toMatchObject({ code: "DOCUMENT_FAILED", status: 422 });
  });

  it("图片没有 OCR 文本时返回 422", () => {
    expect(
      findAttachmentIssue([{ ...readyImage, ocrText: null }]),
    ).toMatchObject({ code: "DOCUMENT_NO_TEXT", status: 422 });
  });

  it("图片 OCR 文本只有空白时也返回 422", () => {
    expect(
      findAttachmentIssue([{ ...readyImage, ocrText: "   " }]),
    ).toMatchObject({ code: "DOCUMENT_NO_TEXT", status: 422 });
  });

  it("文本附件即使 ocrText 为空也可用", () => {
    expect(findAttachmentIssue([readyText])).toBeNull();
  });

  it("图片有 OCR 文本时可用", () => {
    expect(findAttachmentIssue([readyImage])).toBeNull();
  });
});
