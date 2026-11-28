/** M1 候选子应用的静态规则。它是生成质量防护，不是 JavaScript 安全沙箱。 */
import type { SubappManifestDraft, SubappStaticCheck, SubappVersionFiles } from "@pi/shared-types"

import { assertSubappSlug } from "./files.ts"

const MAX_TOOL_BYTES = 256 * 1024
const BANNED_IDENTIFIERS = new Set(["process", "require", "eval", "Function", "import", "child_process"])

export type StaticValidationResult = {
  ok: boolean
  checks: SubappStaticCheck[]
}

function check(checks: SubappStaticCheck[], rule: string, passed: boolean, message?: string): void {
  checks.push({ rule, status: passed ? "passed" : "failed", ...(message === undefined ? {} : { message }) })
}

function normalizedSlug(slug: string): string {
  return slug.replaceAll("-", "_")
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

/**
 * 只提取可执行代码里的 ASCII 标识符：跳过行注释、块注释与普通引号字符串。
 * 为避免在模板插值中漏掉可执行表达式，M1 保守地拒绝模板字面量；M2/M3 如有必要再引入 AST。
 */
function executableIdentifiers(source: string): { identifiers: string[]; templateLiteral: boolean } {
  const identifiers: string[] = []
  let templateLiteral = false
  let index = 0
  while (index < source.length) {
    const char = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (char === "/" && next === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === "`") {
      templateLiteral = true
      index += 1
      continue
    }
    if (isIdentifierStart(char)) {
      const start = index
      index += 1
      while (index < source.length && isIdentifierPart(source[index] ?? "")) index += 1
      identifiers.push(source.slice(start, index))
      continue
    }
    index += 1
  }
  return { identifiers, templateLiteral }
}

function validateManifest(manifest: SubappManifestDraft, checks: SubappStaticCheck[]): void {
  let slugError: string | undefined
  try {
    assertSubappSlug(manifest.slug)
  } catch (error) {
    slugError = error instanceof Error ? error.message : String(error)
  }
  check(checks, "manifest.slug", slugError === undefined, slugError)

  const validTitle = typeof manifest.title === "string" && manifest.title.trim().length > 0 && manifest.title.length <= 80
  check(checks, "manifest.title", validTitle, validTitle ? undefined : "title 必须是 1–80 个字符。")
  check(checks, "manifest.schemaVersion", manifest.schemaVersion === 1, "M1 只支持 schemaVersion=1。")

  const capabilities = manifest.requestedCapabilities
  const m1ReadOnly =
    Array.isArray(capabilities?.writePaths) && capabilities.writePaths.length === 0 &&
    capabilities?.network === false && capabilities?.runsCommands === false
  check(checks, "m1.read-only", m1ReadOnly, "M1 拒绝写入、网络和命令执行申请。")

  const prefix = `user.${normalizedSlug(manifest.slug)}.`
  const tools = capabilities?.tools
  const toolsValid = Array.isArray(tools) && tools.length > 0 &&
    tools.every(name => typeof name === "string" && name.startsWith(prefix)) &&
    new Set(tools).size === tools.length
  check(checks, "manifest.tools", toolsValid, `工具名必须唯一，且以 ${prefix} 开头。`)

  const noUi = manifest.ui === undefined
  check(checks, "m1.no-ui", noUi, "M1 不接受 ui 声明；受控 DSL 在 M2 接入。")
}

function validateSource(files: SubappVersionFiles, checks: SubappStaticCheck[]): void {
  const bytes = Buffer.byteLength(files.tool, "utf8")
  check(checks, "tool.size", bytes > 0 && bytes <= MAX_TOOL_BYTES, `tool.mjs 必须介于 1 B 与 ${MAX_TOOL_BYTES} B。`)
  check(checks, "m1.no-ui-file", files.ui === undefined, "M1 不接受 ui.json；受控 DSL 在 M2 接入。")

  const scan = executableIdentifiers(files.tool)
  check(checks, "tool.no-template-literal", !scan.templateLiteral, "M1 不接受模板字面量，避免漏检插值表达式。")
  const prohibited = [...new Set(scan.identifiers.filter(identifier => BANNED_IDENTIFIERS.has(identifier)))]
  check(
    checks,
    "tool.no-prohibited-identifiers",
    prohibited.length === 0,
    prohibited.length === 0 ? undefined : `禁止标识符：${prohibited.join("、")}`,
  )
}

/** 校验前不得执行候选源码；调用方只可在 ok=true 后进入 smoke。 */
export function validateM1Candidate(
  manifest: SubappManifestDraft,
  files: SubappVersionFiles,
): StaticValidationResult {
  const checks: SubappStaticCheck[] = []
  validateManifest(manifest, checks)
  validateSource(files, checks)
  return { ok: checks.every(item => item.status === "passed"), checks }
}
