import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";

/** 无本地/网络依据时的固定回答（不经过模型，避免模型用自身知识作答） */
export const NO_BASIS_TEXT =
  "我在当前知识库中没有找到依据，因此无法回答这个问题。你可以上传相关资料，或开启「联网搜索」后重试。";

/**
 * 构造一个「无依据」的 UI Message 流。
 *
 * 为什么不用模型生成：模型有自己的通用知识，即使 prompt 说「没有依据就说没有」，
 * 仍可能直接作答。要做到契约里的“无依据不编造”，必须由服务端确定性短路。
 */
export function createNoBasisResponse(params: {
  originalMessages: UIMessage[];
  onFinish: () => Promise<void> | void;
}): Response {
  const stream = createUIMessageStream<UIMessage>({
    originalMessages: params.originalMessages,
    execute: ({ writer }) => {
      const id = "no-basis";
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: NO_BASIS_TEXT });
      writer.write({ type: "text-end", id });
    },
    onFinish: async () => {
      await params.onFinish();
    },
  });

  return createUIMessageStreamResponse({ stream });
}
