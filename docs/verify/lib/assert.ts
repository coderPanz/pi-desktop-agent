/**
 * 阶段验收的最小断言工具。
 *
 * check：硬断言，失败即该阶段验收失败（最终 process.exitCode = 1）。
 * observe：软观察，只记录不判定——用于「模型是否配合」这类不确定项。
 *
 * 验收判定要基于事实（entry 内容、磁盘状态、任务状态），不要基于模型的措辞。
 */

let passed = 0
const failures: string[] = []

/** 硬断言。 */
export function check(name: string, ok: boolean, detail = ""): void {
  const suffix = detail === "" ? "" : `｜${detail}`
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${suffix}`)
    return
  }
  failures.push(name)
  console.log(`✗ ${name}${suffix}`)
}

/** 软观察：只记录。 */
export function observe(name: string, detail = ""): void {
  console.log(`· ${name}${detail === "" ? "" : `｜${detail}`}`)
}

/** 打印汇总，并在有失败时设置退出码。返回是否全部通过。 */
export function report(title: string): boolean {
  const ok = failures.length === 0
  const tail =
    failures.length === 0 ? "" : `，失败 ${failures.length} 项：${failures.join("、")}`
  console.log(`\n${title}：${ok ? "通过" : "未通过"}（通过 ${passed} 项${tail}）`)
  if (!ok) process.exitCode = 1
  return ok
}
