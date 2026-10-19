import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { connection } from "next/server";

export const instant = false;

export default async function Home() {
  await connection();
  const session = await auth();
  redirect(session?.user ? "/chat" : "/login");
}
