import styles from "./status.module.scss";

export default function Loading() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.spinner} aria-hidden />
        <p className={styles.text}>加载中…</p>
      </div>
    </main>
  );
}
