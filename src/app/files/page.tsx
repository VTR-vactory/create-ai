import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { connection } from "next/server";
import FilesClient from "./files-client";

// [block] 登录态页面：请求时渲染，不预渲染
export const instant = false;

export default async function FilesPage() {
  await connection();
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <FilesClient
      user={{
        name: session.user.name,
        email: session.user.email,
        id: session.user.id,
      }}
    />
  );
}
