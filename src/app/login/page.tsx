"use client";

import { useState, useActionState } from "react";
import { handleAuth } from "./actions";
import styles from "./page.module.scss";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [errorMessage, formAction, isPending] = useActionState(
    handleAuth,
    undefined,
  );
  return (
    <main className={styles.loginPage}>
      <form key={mode} className={styles.loginCard} action={formAction}>
        <p className={styles.brand}>KnowFlow AI</p>
        <h1>{mode === "login" ? "欢迎回来" : "创建你的工作台"}</h1>

        <input type="hidden" name="mode" value={mode} />

        {mode === "register" && (
          <label>
            昵称
            <input name="name" minLength={2} required autoComplete="name" />
          </label>
        )}
        <label>
          邮箱
          <input name="email" required type="email" autoComplete="email" />
        </label>
        <label>
          密码
          <input
            name="password"
            minLength={8}
            required
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
          />
        </label>

        {errorMessage && <p className={styles.error}>{errorMessage}</p>}

        <button
          className={styles.primaryButton}
          disabled={isPending}
          type="submit"
        >
          {isPending ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
        </button>
        <button
          className={styles.linkButton}
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          type="button"
        >
          {mode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
        </button>
      </form>
    </main>
  );
}
