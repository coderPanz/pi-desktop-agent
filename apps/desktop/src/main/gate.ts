/**
 * 存储验证
 * pi-durable 的 openNodeSqliteStorage 用的是 Node 内置的 node:sqlite，过了才允许继续做持久化，不通过就立刻改用 better-sqlite3   
 适配器
 */
import { mkdtempSync, rmSync } from "node:fs" // 创建临时目录和删除文件
import { tmpdir } from "node:os" // 获取临时目录路径
import path from "node:path" // 路径处理

import { app } from "electron"

const REQUIRED_NODE_MAJOR = 22 // node 版本

// 打印结果
function line(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `｜${detail}` : ""}`)
}

// 运行验证
async function runGate(): Promise<boolean> {
  console.log("运行时：", {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  })

  const major = Number(process.versions.node.split(".")[0])
  const nodeOk = Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR
  line(nodeOk, `Electron 内置 Node >= ${REQUIRED_NODE_MAJOR}`, process.versions.node)

  let sqliteOk = false
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gate-"))
  const dbPath = path.join(dir, "gate.sqlite")
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(dbPath)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("CREATE TABLE IF NOT EXISTS gate (value TEXT NOT NULL)")
    db.prepare("INSERT INTO gate (value) VALUES (?)").run("ok")
    const row = db.prepare("SELECT value FROM gate LIMIT 1").get() as { value?: string } | undefined
    db.close()
    sqliteOk = row?.value === "ok"
    line(sqliteOk, "node:sqlite 建库 / 建表 / 写入 / 读回（真实文件 + WAL）", dbPath)
  } catch (error) {
    line(false, "node:sqlite 不可用", error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  return nodeOk && sqliteOk
}

app.whenReady().then(async () => {
  const ok = await runGate()
  console.log(
    ok
      ? "\n存储验证通过：可直接使用 node:sqlite 进行持久化。"
      : "\n存储验证失败：需要使用 better-sqlite3 适配器。",
  )
  app.exit(ok ? 0 : 1)
})
