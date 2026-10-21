import Link from "next/link";
import styles from "./status.module.scss";

export default function NotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.code}>404</span>
        <h1 className={styles.title}>页面不存在</h1>
        <p className={styles.text}>
          你访问的地址可能已被移动或删除，可以回到工作台继续。
        </p>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/chat">
            回到工作台
          </Link>
          <Link className={styles.secondary} href="/">
            返回首页
          </Link>
        </div>
      </div>
    </main>
  );
}
