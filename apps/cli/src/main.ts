/**
 * @pi/cli — 无 Electron 的终端入口（阶段 3 落地）。
 *
 * 存在的理由：不启动 Electron 就能复现「排队 / 中断 / 分叉 / 恢复」这类问题，
 * 也让阶段 3–4 的验收与阶段 5 的 IPC 共用同一套 SessionManager。
 *
 * 规划：
 *   main.ts      REPL 主循环（一行 → 命令或消息）
 *   commands.ts  /new /list /switch /abort /fork /reset /compact /inbox /mode /exit
 *   render.ts    帧 → 终端输出（convId 前缀，只打文本与工具摘要）
 *   args.ts      --data-dir / --memory / --partial-interval-ms
 */
console.log("apps/cli 将在阶段 3 落地（SessionManager + REPL）。")
