/**
 * P0.3 生产包验证：确认 asar 内的主进程可从应用数据目录动态导入外部 `.mjs`。
 *
 * 仅由 PI_SUBAPP_P0_PACKAGE_IMPORT=1 触发；不属于正常应用运行路径。
 */
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type PackagedSubappImportProbeInput = {
  readonly dataDir: string
  readonly importerUrl: string
  readonly packaged: boolean
}

export type PackagedSubappImportProbeResult = {
  readonly importerUrl: string
  readonly moduleFile: string
  readonly errors: readonly string[]
}

type ProbeModule = { default: () => string }

async function importVersion(file: string, version: number): Promise<ProbeModule> {
  return await import(`${pathToFileURL(file).href}?v=${version}`) as ProbeModule
}

async function expectImportFailure(file: string, version: number): Promise<string> {
  try {
    await importVersion(file, version)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert.notEqual(message.trim(), "")
    return message
  }
  throw new Error(`预期动态导入失败，但成功加载了 ${file}`)
}

/** 在打包应用内执行。调用方负责打印结果并退出 Electron。 */
export async function runPackagedSubappImportProbe(
  input: PackagedSubappImportProbeInput,
): Promise<PackagedSubappImportProbeResult> {
  assert.equal(input.packaged, true, "P0.3 包内验证只能在 app.isPackaged=true 时执行")
  assert.match(input.importerUrl, /\.asar(?:\/|$)/, "动态导入发起方不在 app.asar 内")

  const directory = path.join(input.dataDir, "subapps", "p0-import", "versions", "1")
  const moduleFile = path.join(directory, "tool.mjs")
  await mkdir(directory, { recursive: true })

  await writeFile(moduleFile, "export default () => 'v1'\n", "utf8")
  const first = await importVersion(moduleFile, 1)
  assert.equal(first.default(), "v1")

  await writeFile(moduleFile, "export default () => 'v2'\n", "utf8")
  const second = await importVersion(moduleFile, 2)
  assert.equal(second.default(), "v2")

  await writeFile(moduleFile, "export default () => {\n", "utf8")
  const syntaxError = await expectImportFailure(moduleFile, 3)
  const missingError = await expectImportFailure(path.join(directory, "missing.mjs"), 1)

  return {
    importerUrl: input.importerUrl,
    moduleFile,
    errors: [syntaxError, missingError],
  }
}
