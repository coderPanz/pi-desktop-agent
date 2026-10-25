/**
 * SQLite 持久化的最小封装：打开存储 → 打开 Harness → 恢复调度 → 取根会话。
 * 只负责「按固定顺序把它们连起来」，不做打印。
 */

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Models } from "@earendil-works/pi-ai";
import {
  Harness,
  type HarnessSettings,
  type RegistryReader,
  type SessionEnd,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type OpenDurableOptions = {
  /** 数据目录，数据库放在 <dataDir>/session.sqlite。 */
  dataDir?: string;
  models: Models;
  registry: RegistryReader;
  settings?: HarnessSettings;
  /** 会话结束（正常关闭或存储失败）时回调。 */
  onClosed?: (end: SessionEnd) => void;
  ctx?: Context;
};

export type Durable = {
  dataDir: string;
  dbPath: string;
  harness: Harness;
  root: Awaited<ReturnType<Harness["root"]>>;
  ctx: Context;
  close: () => Promise<void>;
};

/**
 * 固定启动顺序（顺序本身很重要）：
 *   storage → Harness.open → resume() → root()
 * 少了 resume() 就没有调度，排队和中断都不会推进。
 */
export async function openDurable(options: OpenDurableOptions): Promise<Durable> {
  const ctx = options.ctx ?? BACKGROUND_CONTEXT;
  const dataDir = resolve(options.dataDir ?? ".data");
  await mkdir(dataDir, { recursive: true });
  const dbPath = join(dataDir, "session.sqlite");

  const storage = await openNodeSqliteStorage(dbPath, { busyTimeoutMs: 5000 });
  const harness = await Harness.open(storage, {
    models: options.models,
    registry: options.registry,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  }, ctx);

  // 存储失败会让会话关闭；此时必须停止接受新命令，所以把结束原因交出去。
  void harness.closed.then((end) => options.onClosed?.(end));

  harness.resume();
  const root = await harness.root(ctx);

  // close 只关一次：SIGINT 与 finally 都可能调用。
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= harness.close(ctx).then(() => storage.close(ctx));
    return closing;
  };

  return { dataDir, dbPath, harness, root, ctx, close };
}

/**
 * 备份：用 SQLite 的 VACUUM INTO 生成一个一致的副本。
 * 直接拷 session.sqlite 会漏掉 WAL 里尚未 checkpoint 的内容。
 */
export async function backupDatabase(dbPath: string, target: string): Promise<void> {
  // VACUUM INTO 要求目标文件不存在。
  await rm(target, { force: true });
  const db = await openNodeSqliteDatabase(dbPath);
  try {
    await db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    await db.close();
  }
}
