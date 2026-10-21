import styles from "../status.module.scss";

export default function FilesLoading() {
  return (
    <main className={styles.page}>
      <div className={styles.skeletonList} aria-label="正在加载文件列表">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    </main>
  );
}
