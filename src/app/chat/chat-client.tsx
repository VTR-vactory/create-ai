"use client";

import { useState, useEffect, useMemo, Suspense, useRef } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { signOut } from "next-auth/react";
import { getJson, postJson, postForm, deleteJson, patchJson } from "@/lib/api";
import styles from "./page.module.scss";

type SourceLink = { index: number; title: string; url: string };

type StoredMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  attachments?: { id: string; name: string; mimeType?: string | null }[];
  sources?: SourceLink[] | null;
};
type ChatDetail = { id: string; title: string; messages: StoredMessage[] };

// 由服务端 page.tsx 读取 auth() 后传入
type ChatUser = { name?: string | null; email?: string | null };

type ChatSummary = { id: string; title: string; updatedAt: string };

const SAMPLE_QUESTIONS = [
  "KnowFlow 如何保护模型密钥？",
  "RAG 检索是怎么工作的？",
  "我能上传哪些资料？",
];

const BOTTOM_THRESHOLD = 64;

function toUiMessage(message: StoredMessage): UIMessage {
  return {
    id: message.id,
    role: message.role === "USER" ? "user" : "assistant",
    parts: [{ type: "text", text: message.content }],
    metadata:
      message.sources && message.sources.length
        ? { sources: message.sources }
        : undefined,
  };
}

function sourcesOf(message: UIMessage): SourceLink[] {
  const metadata = message.metadata as { sources?: SourceLink[] } | undefined;
  return Array.isArray(metadata?.sources) ? metadata.sources : [];
}

/** 把回答里的【1】/ [1] / Markdown 链接 / 裸 URL 渲染成可点击节点 */
function renderRichText(text: string, sources: SourceLink[]) {
  const nodes: React.ReactNode[] = [];
  const pattern =
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|【(\d+)】|\[(\d+)\]|(https?:\/\/[^\s）)]+)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));

    const [, label, url, citeFull, citeShort, bareUrl] = match;

    if (label && url) {
      nodes.push(
        <a
          key={`md-${index}`}
          className={styles.messageLink}
          href={url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {label}
        </a>,
      );
    } else if (citeFull || citeShort) {
      const n = Number(citeFull ?? citeShort);
      const source = sources.find((item) => item.index === n);
      nodes.push(
        source ? (
          <a
            key={`cite-${index}`}
            className={styles.citation}
            href={source.url}
            rel="noopener noreferrer"
            target="_blank"
            title={source.title}
          >
            {n}
          </a>
        ) : (
          <sup key={`cite-${index}`} className={styles.citation}>
            {n}
          </sup>
        ),
      );
    } else if (bareUrl) {
      nodes.push(
        <a
          key={`url-${index}`}
          className={styles.messageLink}
          href={bareUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {bareUrl}
        </a>,
      );
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function textOf(message: UIMessage) {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// 文件类型简图：按扩展名给出短标签
function fileBadge(name: string) {
  const ext = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
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
function ChatContent({ user }: { user: ChatUser }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [chatId, setChatId] = useState<string | null>(null);
  // 联网开关：开启后，仅当本地知识库无命中时才会联网
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const currentChat = chats.find((c) => c.id === chatId);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
      }),
    [],
  );
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    regenerate,
    stop,
    error: chatError,
    clearError,
  } = useChat({
    transport,
  });
  const canRetry =
    status === "error" && messages.some((message) => message.role === "user");

  const busy = status === "streaming" || status === "submitted";
  const loadingChatsRef = useRef(false);
  const creatingChatRef = useRef(false);

  // 待挂载的附件：用户消息一出现就立刻显示，无需等 AI 完成
  const pendingAttachmentsRef = useRef<
    { id: string; name: string; mimeType: string }[] | null
  >(null);

  async function loadChats() {
    // React StrictMode 会重复执行 effect；加锁避免两个请求都看到空列表后各建一个会话
    if (loadingChatsRef.current) return;
    loadingChatsRef.current = true;

    try {
      setLoadingChats(true);
      const data = await getJson<ChatSummary[]>("api/chats");
      setChats(data);
      if (data.length) {
        await selectChat(data[0].id);
      } else await createChat();
    } catch {
    } finally {
      loadingChatsRef.current = false;
      setLoadingChats(false);
    }
  }
  async function selectChat(id: string) {
    try {
      setError(null);
      const detail = await getJson<ChatDetail>(`/api/chats/${id}`);
      setChatId(id);
      setMessages(detail.messages.map(toUiMessage));
      // 👇 新增：切换会话时清空上一次的重试附件引用
      lastAttachmentIdsRef.current = [];
      // 历史恢复：按消息 id 建立附件映射
      setAttachments(
        Object.fromEntries(
          detail.messages
            .filter((m) => m.attachments && m.attachments.length > 0)
            .map((m) => [m.id, m.attachments ?? []]),
        ),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "加载对话失败。",
      );
    }
  }

  async function createChat() {
    if (creatingChatRef.current || busy) return;
    creatingChatRef.current = true;

    try {
      const chat = await postJson<ChatSummary>("/api/chats", {});
      setChats((prev) => [chat, ...prev]);
      // 👇 新增：新建会话时同样清空
      lastAttachmentIdsRef.current = [];
      // 给 selectChat 加上 await，保证顺序
      await selectChat(chat.id);

      setMessages([]);
      setError(null);
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建对话失败。",
      );
    } finally {
      creatingChatRef.current = false;
    }
  }

  const [uploading, setUploading] = useState(false);

  // 最近一次发送携带的附件 id（供重试时复用以保持一致范围）
  const lastAttachmentIdsRef = useRef<string[]>([]);
  // 消息 id → 附件列表（本轮乐观显示 + 历史恢复）
  const [attachments, setAttachments] = useState<
    Record<string, { id: string; name: string; mimeType?: string | null }[]>
  >({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    const hasFiles = files.length > 0;
    const hasText = text.length > 0;
    // 只发文件 or 只发文字，都允许
    if ((!hasText && !hasFiles) || busy || uploading || !chatId) return;
    const activeChatId = chatId;
    setInput("");
    setError("");
    stickToBottomRef.current = true;
    try {
      // ① 有文件 → 先上传，拿到 documentId[] 作为本轮附件
      let attachmentIds: string[] = [];
      let uploaded: { id: string; name: string; mimeType: string }[] = [];
      if (hasFiles) {
        setUploading(true);
        try {
          attachmentIds = await uploadFiles(files, activeChatId);
          uploaded = files
            .map((item, index) => ({
              id: attachmentIds[index],
              name: item.name,
              mimeType: item.file.type,
            }))
            .filter(
              (item): item is { id: string; name: string; mimeType: string } =>
                Boolean(item.id),
            );
          setFiles([]);
        } finally {
          setUploading(false);
        }
      }
      lastAttachmentIdsRef.current = attachmentIds;
      // 先登记待显示附件，用户消息一出现立刻渲染（不等 AI 完成）
      pendingAttachmentsRef.current = uploaded.length ? uploaded : null;
      // ③ 发送消息：带上 attachmentIds 与联网开关
      await sendMessage(
        { text },
        {
          body: {
            chatId: activeChatId,
            attachmentIds,
            useWebSearch: webSearchEnabled,
          },
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败，请稍后重试。");
    } finally {
      void refreshChatList();
    }
  }

  async function uploadFiles(
    items: FileItem[],
    chatId: string,
  ): Promise<string[]> {
    const formData = new FormData();
    for (const item of items) {
      // ⚠️ 第三个参数是文件名，必须传，否则中文名可能丢失
      formData.append("files", item.file, item.name);
    }
    formData.append("chatId", chatId); // ⚠️ 需要传 chatId，否则无法关联到聊天记录

    // 用 postForm：内部不设 Content-Type，浏览器自动带 multipart boundary
    const data = await postForm<{
      documents: { id: string; name: string }[];
    }>("/api/documents", formData);
    return data.documents.map((d) => d.id);
  }

  async function retry() {
    if (!chatId || busy) return;
    setError("");
    clearError();
    stickToBottomRef.current = true;
    try {
      await regenerate({
        body: {
          chatId,
          attachmentIds: lastAttachmentIdsRef.current,
          useWebSearch: webSearchEnabled,
        },
      });
    } catch (retryError) {
      setError(
        retryError instanceof Error
          ? retryError.message
          : "重试失败，请稍后重试。",
      );
    } finally {
      void refreshChatList();
    }
  }

  async function refreshChatList() {
    try {
      const data = await getJson<ChatSummary[]>("/api/chats");
      setChats(data);
    } catch {
      // A failed list refresh should not interrupt the conversation.
    }
  }

  const [menu, setMenu] = useState<{
    chatId: string;
    top: number;
    left: number;
  } | null>(null);

  function openChatMenu(
    e: React.MouseEvent<HTMLButtonElement>,
    targetId: string,
  ) {
    if (busy) return;
    e.stopPropagation();
    e.preventDefault();
    if (menu?.chatId === targetId) {
      setMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const width = 148;
    const height = 96;
    let left = rect.left;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    setMenu({ chatId: targetId, top, left });
  }

  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>("");

  async function beginRename(id: string) {
    setMenu(null);
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    setEditId(id);
    setEditTitle(target.title ?? "");
  }
  async function saveRename(event?: React.SyntheticEvent) {
    event?.preventDefault();
    if (editId && editTitle) {
      const original = chats.find((chat) => chat.id === editId)?.title ?? "";
      const title = editTitle.trim();
      if (!title || title === original) {
        cancelRename();
        return;
      }
      try {
        const updated = await patchJson<ChatSummary>(`/api/chats/${editId}`, {
          title,
        });
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === updated.id ? { ...chat, title: updated.title } : chat,
          ),
        );
      } catch (renameError) {
        setError(
          renameError instanceof Error ? renameError.message : "重命名失败。",
        );
      } finally {
        cancelRename();
      }
    }
  }

  function cancelRename() {
    setEditId(null);
    setEditTitle("");
  }
  async function requestDelete(id: string) {
    setMenu(null);

    const target = chats.find((c) => c.id === id);
    if (!target) return;
    if (
      !window.confirm(
        `确定删除“${target?.title ?? "该对话"}”及其全部消息吗？此操作不可撤销。`,
      )
    ) {
      return;
    }
    try {
      await deleteJson(`/api/chats/${id}`);

      const rest = chats.filter((c) => c.id !== id);
      setChats(rest);
      if (id == chatId) {
        if (rest[0]) await selectChat(rest[0].id);
        else await createChat();
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "删除对话失败。",
      );
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //   监听网络
  useEffect(() => {
    const update = () => setOnline(!!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  //   当前登录用户由服务端传入（见 page.tsx），此处不再需要客户端获取

  type FileKind = "text" | "image" | "other";

  //   拖拽上传

  type FileItem = {
    id: string;
    name: string;
    file: File;
    kind: FileKind;
    preview?: string; // 图片预览 URL / 文本前 N 字符
  };

  const [dragging, setDragging] = useState(false);

  const [files, setFiles] = useState<FileItem[]>([]);

  function getKind(file: File): FileKind {
    if (file.type.startsWith("image/")) return "image";
    if (
      file.type.startsWith("text/") ||
      /\.(txt|md|markdown|csv|json|log)$/i.test(file.name)
    ) {
      return "text";
    }
    return "other";
  }
  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }
  function removeFile(id: string) {
    setFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.kind === "image" && target.preview) {
        URL.revokeObjectURL(target.preview);
      }
      return prev.filter((item) => item.id !== id);
    });
  }
  function addFiles(picked: File[]) {
    if (!picked.length) return;

    setFiles((prev) => [
      ...prev,
      ...picked.map((file) => {
        const kind = getKind(file);
        const item: FileItem = {
          id: crypto.randomUUID(),
          name: file.name,
          file,
          kind,
        };
        if (kind === "image") item.preview = URL.createObjectURL(file);
        return item;
      }),
    ]);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= BOTTOM_THRESHOLD;
  }

  //   自动滚动

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  // 用户消息一出现，就把本轮待显示附件挂上去（即时显示缩略图/简图）
  useEffect(() => {
    const pending = pendingAttachmentsRef.current;
    if (!pending?.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === "user") {
      pendingAttachmentsRef.current = null;
      setAttachments((prev) => ({ ...prev, [last.id]: pending }));
    }
  }, [messages]);

  return (
    <div className={styles.chatContainer}>
      <aside className={styles.chatAside}>
        <header className={styles.asideHeader}>
          <p className={styles.brand}>KnowFlow AI</p>
          <p className={styles.caption}>你的私有知识库工作台</p>
        </header>

        <button onClick={createChat}> +新建对话</button>
        <Link className={styles.asideLink} href="/files">
          我的文件
        </Link>
        <div className={styles.asideContent}>
          {loadingChats ? (
            <p>加载中......</p>
          ) : (
            chats.map((chat) => {
              return (
                <div
                  key={chat.id}
                  className={`${styles.chatItem} ${chat.id === chatId ? styles.active : ""}`}
                  onClick={() => void selectChat(chat.id)}
                >
                  {editId === chat.id ? (
                    <form onSubmit={saveRename}>
                      <input
                        aria-label="对话标题"
                        autoFocus
                        className={styles.chatTitleInput}
                        disabled={busy}
                        maxLength={80}
                        onBlur={saveRename}
                        onChange={(event) => setEditTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") cancelRename();
                        }}
                        value={editTitle}
                      />
                    </form>
                  ) : (
                    <>
                      <span className={styles.chatName}>{chat.title}</span>
                      <button
                        aria-label="更多操作"
                        className={styles.btnIcon}
                        data-chat-menu-trigger
                        disabled={busy}
                        onClick={(event) => openChatMenu(event, chat.id)}
                        title="更多操作"
                        type="button"
                      >
                        <svg
                          fill="none"
                          height="16"
                          viewBox="0 0 16 16"
                          width="16"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M4.55146 8.00001C4.55146 8.63513 4.03659 9.15001 3.40146 9.15001C2.76634 9.15001 2.25146 8.63513 2.25146 8.00001C2.25146 7.36488 2.76634 6.85001 3.40146 6.85001C4.03659 6.85001 4.55146 7.36488 4.55146 8.00001Z"
                            fill="currentColor"
                          />
                          <path
                            d="M9.1476 8.00001C9.1476 8.63513 8.63273 9.15001 7.9976 9.15001C7.36248 9.15001 6.8476 8.63513 6.8476 8.00001C6.8476 7.36488 7.36248 6.85001 7.9976 6.85001C8.63273 6.85001 9.1476 7.36488 9.1476 8.00001Z"
                            fill="currentColor"
                          />
                          <path
                            d="M13.7486 8.00001C13.7486 8.63513 13.2338 9.15001 12.5986 9.15001C11.9635 9.15001 11.4486 8.63513 11.4486 8.00001C11.4486 7.36488 11.9635 6.85001 12.5986 6.85001C13.2338 6.85001 13.7486 7.36488 13.7486 8.00001Z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        <footer className={styles.asideFooter}>
          <div className={styles.userBox}>
            <span className={styles.userAvatar}>
              {(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}
            </span>
            <div className={styles.userInfo}>
              <span className={styles.userName}>
                {user?.name || user?.email || "已登录"}
              </span>
              {user?.name && user?.email ? (
                <span className={styles.userEmail}>{user.email}</span>
              ) : null}
            </div>
          </div>
          <button
            className={styles.logoutBtn}
            type="button"
            onClick={() => void signOut({ redirectTo: "/login" })}
          >
            退出登录
          </button>
        </footer>
      </aside>

      <div className={styles.chatMain}>
        <div className={styles.chatHeader}>
          {currentChat?.title || "知识库对话"}
        </div>
        <div
          className={styles.chatContent}
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {messages.length === 0 && !busy && (
            <div className={styles.emptyState}>
              <h1>从一个问题开始</h1>
              <p>先点击“上传示例资料”，再问 KnowFlow 如何保护模型密钥。</p>
              <div className={styles.sampleQuestions}>
                {SAMPLE_QUESTIONS.map((question) => (
                  <button
                    className={styles.sampleButton}
                    key={question}
                    onClick={() => setInput(question)}
                    type="button"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => {
            const messageSources = sourcesOf(message);
            return (
              <article
                key={message.id}
                className={message.role === "user" ? styles.user : styles.ai}
              >
                <span>{message.role == "user" ? "Me" : "AI"}</span>

                {textOf(message) ? (
                  <p>
                    {message.role === "assistant"
                      ? renderRichText(textOf(message), messageSources)
                      : textOf(message)}
                  </p>
                ) : null}

                {message.role === "assistant" && messageSources.length > 0 ? (
                  <div className={styles.sources}>
                    <span className={styles.sourcesLabel}>来源</span>
                    {messageSources.map((source) => (
                      <a
                        key={source.index}
                        className={styles.sourceItem}
                        href={source.url}
                        rel="noopener noreferrer"
                        target="_blank"
                        title={source.title}
                      >
                        [{source.index}] {source.title || source.url}
                      </a>
                    ))}
                  </div>
                ) : null}
                {attachments[message.id]?.length ? (
                  <ul className={styles.msgFiles}>
                    {attachments[message.id].map((file) =>
                      file.mimeType?.startsWith("image/") ? (
                        <li key={file.id} className={styles.msgThumbItem}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            className={styles.msgThumb}
                            src={`/api/documents/${file.id}/raw`}
                            alt={file.name}
                          />
                        </li>
                      ) : (
                        <li key={file.id} className={styles.msgDoc}>
                          <span className={styles.msgDocIcon}>
                            {fileBadge(file.name)}
                          </span>
                          <span className={styles.msgDocName}>{file.name}</span>
                        </li>
                      ),
                    )}
                  </ul>
                ) : null}
              </article>
            );
          })}
          {busy && <p className={styles.muted}>AI 正在思考…</p>}
        </div>
        {!online && (
          <div className={styles.offlineBar}>
            当前网络已断开，恢复网络后即可继续对话。
          </div>
        )}
        {(error || chatError) && (
          <div className={styles.errorBar}>
            <span>{error || chatError?.message}</span>
            <div className={styles.errorActions}>
              {canRetry && (
                <button
                  className={styles.secondaryButton}
                  onClick={() => void retry()}
                  type="button"
                >
                  重试
                </button>
              )}
              <button
                className={styles.linkButton}
                onClick={() => {
                  setError("");
                  clearError();
                }}
                type="button"
              >
                关闭
              </button>
            </div>
          </div>
        )}
        <footer
          className={`${styles.chatFooter} ${dragging ? styles.dragging : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {files.length > 0 && (
            <ul className={styles.fileList}>
              {files.map((item) => (
                <li key={item.id} className={styles.fileItem}>
                  {item.kind === "image" && item.preview && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.preview}
                      alt={item.name}
                      className={styles.thumb}
                    />
                  )}
                  {item.kind !== "image" && (
                    <span className={styles.fileBadge}>
                      {fileBadge(item.name)}
                    </span>
                  )}

                  <span className={styles.fileName} title={item.name}>
                    {item.name}
                  </span>

                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => removeFile(item.id)}
                    aria-label={`移除 ${item.name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submit} id="chat-form">
            <textarea
              placeholder="输入你的问题"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </form>

          <div>
            <div className={styles.composerLeft}>
              <button
                type="button"
                className={`${styles.webToggle} ${webSearchEnabled ? styles.webToggleOn : ""}`}
                aria-pressed={webSearchEnabled}
                onClick={() => setWebSearchEnabled((value) => !value)}
                title="开启后：本地知识库没有结果时才会联网搜索"
              >
                <span className={styles.webDot} />
                联网搜索{webSearchEnabled ? "已开" : "关闭"}
              </button>
              {webSearchEnabled && (
                <span className={styles.webHint}>
                  问题会发送给第三方搜索服务
                </span>
              )}
            </div>

            <div className={styles.composerRight}>
              <span>Enter 发送 · Shift + Enter 换行</span>

              <button
                className={styles.fileBtn}
              type="button"
              aria-label="添加附件"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M5.5498 9.75V5H6.9502V9.75C6.9502 10.3299 7.4201 10.7998 8 10.7998C8.5799 10.7998 9.0498 10.3299 9.0498 9.75V4.5C9.0498 2.9536 7.7964 1.7002 6.25 1.7002C4.7036 1.7002 3.4502 2.9536 3.4502 4.5V9.75C3.4502 12.2629 5.4871 14.2998 8 14.2998C10.5129 14.2998 12.5498 12.2629 12.5498 9.75V4H13.9502V9.75C13.9502 13.0361 11.2861 15.7002 8 15.7002C4.71391 15.7002 2.0498 13.0361 2.0498 9.75V4.5C2.04981 2.1804 3.9304 0.299806 6.25 0.299805C8.5696 0.299805 10.4502 2.1804 10.4502 4.5V9.75C10.4502 11.1031 9.3531 12.2002 8 12.2002C6.6469 12.2002 5.5498 11.1031 5.5498 9.75Z"
                  fill="currentColor"
                ></path>
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,.csv,.json,.log,image/*"
              className={styles.hiddenInput}
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                if (picked.length) addFiles(picked);
                event.target.value = "";
              }}
            />
            {busy ? (
              <button
                className={styles.secondaryButton}
                onClick={stop}
                type="button"
              >
                停止生成
              </button>
            ) : (
              <button
                form="chat-form"
                className={styles.primaryButton}
                disabled={
                  (!input.trim() && files.length === 0) ||
                  !chatId ||
                  busy ||
                  uploading
                }
                type="submit"
              >
                发送
              </button>
            )}
            </div>
          </div>
        </footer>
      </div>

      {menu && (
        <div
          className={styles.chatMenu}
          data-chat-menu
          role="menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <button
            className={styles.chatMenuItem}
            onClick={() => beginRename(menu.chatId)}
            role="menuitem"
            type="button"
          >
            重命名
          </button>
          <button
            className={`${styles.chatMenuItem} ${styles.chatMenuItemDanger}`}
            onClick={() => void requestDelete(menu.chatId)}
            role="menuitem"
            type="button"
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export default function ChatClient({ user }: { user: ChatUser }) {
  return (
    <Suspense fallback={null}>
      <ChatContent user={user} />
    </Suspense>
  );
}
