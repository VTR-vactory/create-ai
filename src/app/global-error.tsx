"use client";

import styles from "./status.module.scss";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <main className={styles.page}>
          <div className={styles.card}>
            <span className={styles.code}>500</span>
            <h1 className={styles.title}>应用出错了</h1>
            <p className={styles.text}>
              页面无法正常加载，请刷新或稍后重试。
            </p>
            <div className={styles.actions}>
              <button className={styles.primary} onClick={reset} type="button">
                刷新重试
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
