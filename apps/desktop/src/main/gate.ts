/**
 * 存储门禁（G2）。必须跑在 Electron 的 Node 运行时里，不能只在系统 Node 上验。
 *
 * 通过 → 阶段 5 可以用 node:sqlite；
 * 不通过 → 立刻停下，改用 better-sqlite3 适配 chord 的 SqliteDatabase 六方法
 *          （exec / run / get / all / transaction / close），再交给 SqliteStorage.open(db)。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { app } from "electron"

const REQUIRED_NODE_MAJOR = 22

function line(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `｜${detail}` : ""}`)
}

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
      ? "\n门禁通过：可以继续阶段 5（SqliteStorage 直接用 node:sqlite）。"
      : "\n门禁失败：按 技术方案二.md §15 G2 的兜底方案，写 better-sqlite3 适配器。",
  )
  app.exit(ok ? 0 : 1)
})
