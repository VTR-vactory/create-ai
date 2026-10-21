"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { getJson, postForm, deleteJson } from "@/lib/api";
import Link from "next/link";
import styles from "./page.module.scss";

type FileStatus = "READY" | "PROCESSING" | "FAILED";

type UploadedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: FileStatus;
  chunkCount: number;
  createdAt: string;
  preview?: string;
};

type FileFilter = "all" | "text" | "image";

// 界面预览用的示例数据；接入 GET /api/documents 后替换。

const STATUS_LABEL: Record<FileStatus, string> = {
  READY: "已就绪",
  PROCESSING: "处理中",
  FAILED: "处理失败",
};

const STATUS_CLASS: Record<FileStatus, string> = {
  READY: styles.statusReady,
  PROCESSING: styles.statusProcessing,
  FAILED: styles.statusFailed,
};

const FILTERS: { key: FileFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "text", label: "文档" },
  { key: "image", label: "图片" },
];

function isImage(file: UploadedFile) {
  return file.mimeType.startsWith("image/");
}

function badgeOf(file: UploadedFile) {
  if (isImage(file)) return "IMG";
  const ext = file.name.includes(".")
    ? (file.name.split(".").pop() ?? "").toLowerCase()
    : "";
  const map: Record<string, string> = {
    md: "MD",
    markdown: "MD",
    txt: "TXT",
    csv: "CSV",
    json: "JSON",
    log: "LOG",
  };
  return map[ext] ?? (ext ? ext.slice(0, 4).toUpperCase() : "FILE");
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 用固定格式避免服务端/客户端时区差异导致 hydration 警告
function formatDate(iso: string) {
  return iso.slice(0, 10);
}

export default function FilesClient({
  user,
}: {
  user: { name?: string | null; email?: string | null; id?: string | null };
}) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FileFilter>("all");
  const [errorMessage, setErrorMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const visibleFiles = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return files.filter((file) => {
      if (filter === "text" && isImage(file)) return false;
      if (filter === "image" && !isImage(file)) return false;
      if (keyword && !file.name.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [files, filter, query]);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

  const allVisibleSelected =
    visibleFiles.length > 0 &&
    visibleFiles.every((file) => selected.has(file.id));

  const displayName = user.name || user.email || "已登录";

  async function handlePick(picked: FileList | null) {
    if (!picked?.length) return;
    setErrorMessage("");

    const formData = new FormData();
    for (const file of Array.from(picked)) {
      formData.append("files", file, file.name);
    }

    try {
      // 复用现有的上传接口（切块 + embedding + 状态机由服务端处理）
      await postForm("/api/documents", formData);
      await loadFiles();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "上传失败，请稍后重试。",
      );
    }
  }

  async function handleDelete(file: UploadedFile) {
    if (!window.confirm(`确定删除「${file.name}」吗？`)) return;
    setErrorMessage("");

    try {
      await deleteJson(`/api/files/${file.id}`);
      if (file.preview) URL.revokeObjectURL(file.preview);
      setFiles((previous) => previous.filter((item) => item.id !== file.id));
      setSelected((previous) => {
        const next = new Set(previous);
        next.delete(file.id);
        return next;
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "删除失败，请稍后重试。",
      );
    }
  }

  function toggleSelect(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) {
        visibleFiles.forEach((file) => next.delete(file.id));
      } else {
        visibleFiles.forEach((file) => next.add(file.id));
      }
      return next;
    });
  }

  async function handleBatchDelete() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 个文件吗？`)) return;
    setErrorMessage("");

    try {
      const result = await deleteJson<{ deleted: number }>("/api/files", {
        ids,
      });
      const idSet = new Set(ids);
      setFiles((previous) => previous.filter((file) => !idSet.has(file.id)));
      setSelected(new Set());

      if (result.deleted < ids.length) {
        setErrorMessage(
          `已删除 ${result.deleted} 个，部分文件可能已不存在。`,
        );
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "批量删除失败，请稍后重试。",
      );
    }
  }

  async function loadFiles() {
    try {
      const result = await getJson<UploadedFile[]>("/api/files");
      setFiles(result);
      setSelected(new Set());
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "加载文件列表失败。",
      );
    }
  }

  useEffect(() => {
    void loadFiles();
  }, []);

  return (
    <main className={styles.filesPage}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/chat">
            KnowFlow AI
          </Link>
          <Link className={styles.backLink} href="/chat">
            ← 返回对话
          </Link>
        </div>
      </header>

      <div className={styles.main}>
        <div className={styles.hero}>
          <div>
            <h1 className={styles.title}>我的文件</h1>
            <p className={styles.subtitle}>
              {displayName} · 共 {files.length} 个文件 · {formatSize(totalSize)}
            </p>
          </div>
          <button
            className={styles.uploadButton}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            + 上传文件
          </button>
          <input
            ref={inputRef}
            className={styles.hiddenInput}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.log,image/*"
            onChange={(event) => {
              void handlePick(event.target.files);
              event.target.value = "";
            }}
          />
        </div>

        {errorMessage && <div className={styles.notice}>{errorMessage}</div>}

        <div className={styles.toolbar}>
          <input
            className={styles.search}
            placeholder="搜索文件名…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className={styles.filters}>
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={
                  filter === item.key ? styles.filterActive : styles.filter
                }
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {files.length > 0 && (
          <div className={styles.selectionBar}>
            <label className={styles.selectAll}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
              />
              全选
            </label>
            <span className={styles.selectedCount}>已选 {selected.size} 个</span>
            <button
              className={styles.batchButton}
              disabled={selected.size === 0}
              onClick={() => void handleBatchDelete()}
              type="button"
            >
              批量删除
            </button>
          </div>
        )}

        {visibleFiles.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>没有匹配的文件</p>
            <p className={styles.emptyText}>
              {files.length === 0
                ? "上传一份资料，开始构建你的知识库。"
                : "换个关键词或筛选条件试试。"}
            </p>
          </div>
        ) : (
          <ul className={styles.list}>
            {visibleFiles.map((file) => (
              <li
                className={`${styles.card} ${selected.has(file.id) ? styles.cardSelected : ""}`}
                key={file.id}
              >
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={selected.has(file.id)}
                  onChange={() => toggleSelect(file.id)}
                  aria-label={`选择 ${file.name}`}
                />
                {file.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={styles.cardImage}
                    src={file.preview}
                    alt={file.name}
                  />
                ) : (
                  <span className={styles.cardIcon}>{badgeOf(file)}</span>
                )}

                <div className={styles.cardBody}>
                  <div className={styles.cardTop}>
                    <span className={styles.cardName} title={file.name}>
                      {file.name}
                    </span>
                    <span
                      className={`${styles.status} ${STATUS_CLASS[file.status]}`}
                    >
                      {STATUS_LABEL[file.status]}
                    </span>
                  </div>
                  <div className={styles.cardMeta}>
                    <span>{formatSize(file.size)}</span>
                    <span>·</span>
                    <span>{formatDate(file.createdAt)}</span>
                    {file.chunkCount > 0 && (
                      <>
                        <span>·</span>
                        <span>{file.chunkCount} 个片段</span>
                      </>
                    )}
                    {isImage(file) && (
                      <>
                        <span>·</span>
                        <span>不参与检索</span>
                      </>
                    )}
                  </div>
                </div>

                <button
                  className={styles.dangerButton}
                  onClick={() => handleDelete(file)}
                  type="button"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
