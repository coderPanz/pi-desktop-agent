/**
 * 阶段 4：SQLite 持久化与崩溃恢复（核心流程精简版）
 *
 * 子命令：
 *   submit <文本>              落盘提交并等待完成
 *   crash after-submit [文本]  提交后立刻退出（模拟崩溃，不 close）
 *   crash mid-generation [文本] 生成中途退出（模拟崩溃）
 *   probe                      只读打开，打印条目与任务状态（不 resume）
 *   resume                     打开并等待恢复跑完，打印最终条目
 *   backup <路径>               VACUUM INTO 备份
 *
 * 运行：pnpm durable <子命令>
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createRegistry, type EntryRecord } from "@earendil-works/pi-durable";
import { createModelRegistry, pickModel } from "./agent/models.ts";
import { backupDatabase, openDurable, type Durable } from "./core/durable.ts";

const [command, ...rest] = process.argv.slice(2);
const argument = rest.join(" ").trim();

/** 取条目文本（assistant 的 content 是内容块数组）。 */
function textOf(entry: EntryRecord | undefined): string {
  const content = entry?.model?.[0]?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

/** 打印条目摘要与运行状态。 */
async function report(durable: Durable): Promise<void> {
  const entries = (await durable.root.entries({ order: "ascending" }, 100, undefined, durable.ctx)).items;
  console.log(`条目（${entries.length}）：`);
  for (const entry of entries) {
    const text = textOf(entry).replace(/\s+/g, " ").slice(0, 47);
    console.log(`  ${entry.id}\t${entry.kind}\t${text}${text ? "…" : ""}`);
  }

  const inspection = await durable.harness.inspect(durable.ctx);
  console.log("任务：", inspection.tasks.map((task) => `#${task.record.id}:${task.state.kind}`).join(", ") || "(无)");
  console.log("提交：", inspection.submissions.map((item) => `#${item.id}:${item.status}`).join(", ") || "(无)");
}

const models = createModelRegistry();
const model = await pickModel(models);
const registry = createRegistry();

/** 统一的打开方式：崩溃模拟里不调用 close，所以不走这个包装。 */
async function withDurable<T>(work: (durable: Durable) => Promise<T>): Promise<T> {
  const durable = await openDurable({ models, registry });
  await durable.root.configure({ model: { provider: model.provider, modelId: model.id } }, durable.ctx);
  try {
    return await work(durable);
  } finally {
    await durable.close();
  }
}

/** 提交一条问题，返回 submission。 */
async function submitText(durable: Durable, text: string) {
  const submission = await durable.root.submit({ type: "input", content: text, requestId: randomUUID() }, durable.ctx);
  console.log(`已提交 #${submission.id}（requestId ${randomUUID().slice(0, 8)}）：${text}`);
  return submission;
}

try {
  switch (command) {
    case "submit": {
      await withDurable(async (durable) => {
        const submission = await submitText(durable, argument || "用一句话解释什么是持久化。");
        const settled = await submission.wait(durable.ctx);
        console.log(`提交状态：${settled.status}`);
        await report(durable);
      });
      break;
    }

    case "crash": {
      const point = rest[0];
      const text = rest.slice(1).join(" ") || "用约 300 字解释什么是 WAL，分三点。";
      const durable = await openDurable({ models, registry });
      await durable.root.configure({ model: { provider: model.provider, modelId: model.id } }, durable.ctx);
      const submission = await submitText(durable, text);

      if (point === "after-submit") {
        console.log("崩溃点：提交已落盘，进程立即退出（不 close，模拟 kill -9）。");
        process.exit(1);
      }
      if (point === "mid-generation") {
        // 等到「已经有一段回答被提交进 pi.live」再退出，否则可能一个字都没生成。
        const watch = await durable.root.watch(durable.ctx);
        // watch.value 只有在 start() 之后、投递过的帧才会更新，所以要显式订阅并跟踪最新副本。
        let latest = watch.value;
        watch.start(async (value) => {
          latest = value;
        });
        const partial = (): string => {
          const live = latest.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined;
          const content = live?.generation?.message?.content;
          return Array.isArray(content)
            ? content.filter((block) => (block as { type?: string }).type === "text").map((block) => (block as { text?: string }).text ?? "").join("")
            : "";
        };
        const deadline = Date.now() + 5000;
        while (partial() === "" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        console.log(`崩溃点：生成中退出，已提交 ${partial().length} 字：「${partial().slice(0, 30)}…」`);
        process.exit(1);
      }
      console.error(`未知崩溃点：${point ?? "(空)"}，可用 after-submit / mid-generation`);
      await submission.abort(durable.ctx).catch(() => undefined);
      await durable.close();
      process.exitCode = 1;
      break;
    }

    case "probe": {
      // 只读探查：不 resume，所以不会推进任何任务。
      const durable = await openDurable({ models, registry });
      console.log(`数据库：${durable.dbPath}`);
      await report(durable);
      await durable.close();
      break;
    }

    case "resume": {
      const durable = await openDurable({ models, registry });
      // 恢复前先看一眼，恢复后再看一次，差异就是「续跑」的证据。
      console.log("--- 恢复前 ---");
      await report(durable);
      await durable.root.configure({ model: { provider: model.provider, modelId: model.id } }, durable.ctx);
      await durable.harness.waitForIdle(durable.ctx);
      console.log("--- 恢复后（已 idle）---");
      await report(durable);
      await durable.close();
      break;
    }

    case "backup": {
      const target = resolve(argument || ".data/backup.sqlite");
      const durable = await openDurable({ models, registry });
      const items = (await durable.root.entries({ order: "ascending" }, 1000, undefined, durable.ctx)).items.length;
      await durable.close();

      await backupDatabase(durable.dbPath, target);

      // 用另开的连接读备份文件，确认条目数与主库一致。
      const db = await openNodeSqliteDatabase(target);
      const row = await db.get<{ n: number }>("select count(*) as n from entries");
      await db.close();
      console.log(`已备份：${target}`);
      console.log(`主库条目 ${items}，备份条目 ${row?.n ?? 0}`);
      break;
    }

    default:
      console.log("用法：pnpm durable <submit|crash|probe|resume|backup> [参数]");
      console.log("  submit <文本>              落盘提交并等待完成");
      console.log("  crash after-submit [文本]  提交后立刻退出");
      console.log("  crash mid-generation [文本] 生成中途退出");
      console.log("  probe                      只读探查");
      console.log("  resume                     恢复并等待空闲");
      console.log("  backup <路径>               备份数据库");
      process.exitCode = 1;
  }
} catch (error) {
  console.error("运行失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
