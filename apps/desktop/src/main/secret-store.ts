/**
 * 桌面端密钥存储：用 Electron safeStorage 加密后写 userData 文件。
 *
 * 不写 SQLite、不进日志、不交给渲染进程。系统密钥链不可用时**明确报错**，
 * 不退回明文；调用方要提示用户改用 ANTHROPIC_API_KEY 环境变量。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { safeStorage } from "electron"
import type { SecretStore } from "@pi/core"

export function createSafeStorageSecret(file: string): SecretStore {
  const assertAvailable = (): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统密钥链不可用，无法安全保存 API Key；请改用 ANTHROPIC_API_KEY 环境变量。")
    }
  }
  return {
    kind: "safeStorage",
    async read() {
      let raw: Buffer
      try {
        raw = await readFile(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
      if (!safeStorage.isEncryptionAvailable()) return undefined
      try {
        return safeStorage.decryptString(raw)
      } catch {
        // 换机器/换系统用户后旧密文解不开：当作没有密钥，由用户重新填。
        return undefined
      }
    },
    async write(value) {
      assertAvailable()
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, safeStorage.encryptString(value), { mode: 0o600 })
    },
    async clear() {
      await rm(file, { force: true })
    },
  }
}