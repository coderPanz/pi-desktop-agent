/**
 * UI 异常态的展示
 */

export type IpcErrorCode =
  /** 参数错误 */
  | "INVALID_ARGUMENT"
  /** （会话、条目、文档）not found */
  | "NOT_FOUND"
  /** 会话正忙 */
  | "BUSY"
  /** session 错误 */
  | "SESSION_FAILED"
  /** 未知错误 */
  | "UNKNOWN"

export type IpcErrorPayload = {
  readonly code: IpcErrorCode
  readonly message: string
}

/** 主进程内部的错误类型；发给界面前会压成 `IpcErrorPayload`。 */
export class IpcError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = "IpcError"
    this.code = code
  }

  toPayload(): IpcErrorPayload {
    return { code: this.code, message: this.message }
  }
}

/**
 * 任意异常类型转为 UI 渲染类型
 */
export function toIpcErrorPayload(error: unknown): IpcErrorPayload {
  if (error instanceof IpcError) return error.toPayload()
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === "UserError") {
    return { code: "INVALID_ARGUMENT", message }
  }
  if (error instanceof Error && error.name === "SessionFailed") {
    return { code: "SESSION_FAILED", message }
  }
  return { code: "UNKNOWN", message }
}
