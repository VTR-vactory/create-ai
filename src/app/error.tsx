"use client";

import Link from "next/link";
import styles from "./status.module.scss";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.code}>500</span>
        <h1 className={styles.title}>页面出错了</h1>
        <p className={styles.text}>
          请稍后重试。如果问题持续存在，可以返回首页后再试。
        </p>
        {error.digest && (
          <p className={styles.text}>错误编号：{error.digest}</p>
        )}
        <div className={styles.actions}>
          <button className={styles.primary} onClick={reset} type="button">
            重试
          </button>
          <Link className={styles.secondary} href="/">
            返回首页
          </Link>
        </div>
      </div>
    </main>
  );
}
