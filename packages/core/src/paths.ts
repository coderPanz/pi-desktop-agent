/**
 * 路径计算和目录创建
 */
import { mkdir } from "node:fs/promises"
import path from "node:path"

export type WorkspacePaths = {
  /** 数据根：所有本机状态都在它下面 */
  readonly root: string
  /** 模型可读写的工作区目录（工具默认 cwd） */
  readonly workspace: string
  /** Agent 后续生成、检查并经人工确认后安装的工具文件目录【旧工具自举，保留兼容】 */
  readonly tools: string
  /** 子应用不可变版本目录：subapps/<slug>/versions/<version>/。 */
  readonly subapps: string
  /** 结构化日志目录 */
  readonly logs: string
  /** SQLite 单文件库路径（WAL 模式） */
  readonly db: string
}

export type WorkspacePathsOptions = {
  readonly workspace?: string
  /** 库文件名。默认 `session.sqlite`。 */
  readonly dbFile?: string
}

/** 数据存放路径计算 */
export function workspacePaths(root: string, options: WorkspacePathsOptions = {}): WorkspacePaths {
  const base = path.resolve(root) // 解析根路径为绝对路径
  return {
    root: base, // 数据根路径（以下属性为该根路径下的子路径）
    workspace: path.resolve(base, options.workspace ?? "workspace"), // 工作区路径
    tools: path.join(base, "tools"), // 工具路径
    subapps: path.join(base, "subapps"), // 子应用版本目录
    logs: path.join(base, "logs"), // 日志路径
    db: path.join(base, options.dbFile ?? "session.sqlite"), // 数据库路径-绝对
  }
}

/**异步创建工作区、工具、子应用与日志目录。 */
export async function ensureWorkspacePaths(paths: WorkspacePaths): Promise<void> {
  await Promise.all(
    [paths.workspace, paths.tools, paths.subapps, paths.logs].map((dir) => mkdir(dir, { recursive: true })),
  )
}
