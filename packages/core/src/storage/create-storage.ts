/**
 * 存储入口
 * 文件库（ 用 SQLite 数据库文件长期保存数据）走 `node:sqlite`，内存库只给测试与 `--memory` 排障用
 * 两条约定：
 *   1. 存储失败不允许 fallback 到内存库——失败必须显式可见，否则「数据没落盘」会被误当成「功能正常」
 *   2. 一个库文件只允许一个 Harness（单写者）。这里不做跨进程锁，也不重试。
 */
import { mkdir } from "node:fs/promises"
import path from "node:path"

import type { Storage } from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable" // 内存存储

/** 
 * SQLite 底层运行参数：主要处理数据库暂时被占用 和 WAL 日志文件如何整理
 * SQLite 不允许同一时刻，多个操作作用于同一个文件中，确保原子性。
 *  WAL：表示预写日志
*/
export type CreateStorageOptions = {
  // 数据库被占用时，最多要等多久（ms）
  readonly busyTimeoutMs?: number
  // WAL 日志积累到多大时自动整理
  readonly walAutoCheckpointPages?: number
}

export type StorageTarget =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "memory" }

/**  SQLite 默认忙碌等待：5000ms */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/** 创建存储 */
export async function createStorage(
  target: StorageTarget, // 存储目标：SQlite 或内存
  options: CreateStorageOptions = {}, // SQLite 底层运行参数
): Promise<Storage> {
  if (target.kind === "memory") return new MemoryStorage()

  await mkdir(path.dirname(target.file), { recursive: true }) // 创建 SQLite 文件所在的目录
  // 按需加载：内存库路径（测试、`--memory`）不该把 `node:sqlite` 拉进进程。
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node")
  return await openNodeSqliteStorage(target.file, {
    // 打开 SQLite 数据库
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, // 数据库被占用时，最多要等多久（ms）
    walAutoCheckpointPages: options.walAutoCheckpointPages ?? undefined, // WAL 日志积累到多大时自动整理
  })
}
