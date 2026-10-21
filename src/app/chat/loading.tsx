import styles from "../status.module.scss";

export default function ChatLoading() {
  return (
    <main className={styles.page}>
      <div className={styles.skeletonList} aria-label="正在加载对话">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    </main>
  );
}
