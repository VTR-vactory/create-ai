"use server";

import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";

export async function handleAuth(
  prevState: string | undefined,
  formData: FormData,
) {
  const mode = formData.get("mode") === "register" ? "register" : "login";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "");

  if (mode === "register") {
    const parsed = z
      .object({
        name: z.string().min(2, "昵称至少 2 个字符"),
        email: z.email("邮箱格式不正确"),
        password: z.string().min(8, "密码至少 8 位"),
      })
      .safeParse({ name, email, password });

    if (!parsed.success) {
      return parsed.error.issues[0].message;
    }

    const existing = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
    });

    if (existing) {
      return "该邮箱已被注册";
    }
    await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        passwordHash: await bcrypt.hash(parsed.data.password, 12),
      },
    });
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/chat",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return "邮箱或密码不正确";
        default:
          return "登录失败，请重试";
      }
    }
    throw error;
  }
}
