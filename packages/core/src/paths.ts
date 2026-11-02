/**
 * 工作区路径：由调用方注入根路径
 * 这里只做路径计算与目录创建
 */
import { mkdir } from "node:fs/promises"
import path from "node:path"

export type WorkspacePaths = {
  /** 数据根：所有本机状态都在它下面。 */
  readonly root: string
  /** 模型可读写的工作区目录（工具默认 cwd） */
  readonly workspace: string
  /** Agent 后续生成、检查并经人工确认后安装的工具文件目录【该项目特色功能之一】 */
  readonly tools: string
  /** 结构化日志目录 */
  readonly logs: string
  /** SQLite 单文件库路径（WAL 模式） */
  readonly db: string
}

export type WorkspacePathsOptions = {
  /** 工作区目录；相对路径按 `root` 解析。默认 `<root>/workspace`。 */
  readonly workspace?: string
  /** 库文件名。默认 `session.sqlite`。 */
  readonly dbFile?: string
}

/** 计算工作区路径 */
export function workspacePaths(root: string, options: WorkspacePathsOptions = {}): WorkspacePaths {
  const base = path.resolve(root) // 解析根路径为绝对路径
  return {
    root: base, // 根路径
    workspace: path.resolve(base, options.workspace ?? "workspace"), // 工作区路径-绝对
    tools: path.join(base, "tools"), // 工具路径-绝对
    logs: path.join(base, "logs"), // 日志路径-绝对
    db: path.join(base, options.dbFile ?? "session.sqlite"), // 数据库路径-绝对
  }
}

/** 创建工作区、工具、日志三个目录 */
export async function ensureWorkspacePaths(paths: WorkspacePaths): Promise<void> {
  await Promise.all(
    [paths.workspace, paths.tools, paths.logs].map((dir) => mkdir(dir, { recursive: true })),
  )
}
