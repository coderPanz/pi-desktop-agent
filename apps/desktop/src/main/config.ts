import { loadEnvFile } from "node:process"

/** 开发目录的 .env 只是默认值；已导出的环境变量优先。缺文件允许启动，其他读取错误不吞。 */
export function loadDesktopEnv(file: string): void {
  try {
    loadEnvFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
