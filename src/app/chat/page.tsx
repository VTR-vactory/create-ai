import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { connection } from "next/server";
import ChatClient from "./chat-client";

// [block] 登录态页面：请求时渲染，不预渲染
export const instant = false;

export default async function ChatPage() {
  // 显式标记请求时渲染，避免预渲染阶段调用 auth()
  await connection();
  const session = await auth();
  if (!session?.user) redirect("/login");
  return (
    <ChatClient user={{ name: session.user.name, email: session.user.email }} />
  );
}
