/**
 * 渲染进程侧的 IPC 客户端：把 IPC 返回的 `{ ok, value } | { ok, error }` 包成「成功拿值、失败抛带错误码的异常」。
 *
 * 只有这一层知道 `window.pi`：页面与 hook 都不直接碰桥，
 * 这样离线/未注入 preload 时只需要在这里报一次错。
 */
import type {
  IpcChannel,
  IpcErrorCode,
  IpcRequest,
  IpcResponse,
  IpcResult,
  PushChannel,
  PushMap,
} from "@pi/shared-types"

/** 带错误码的调用失败；界面按 `code` 决定提示方式。 */
export class IpcCallError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = "IpcCallError"
    this.code = code
  }
}

function bridge(): NonNullable<Window["pi"]> {
  const api = window.pi
  if (api === undefined) throw new IpcCallError("UNKNOWN", "preload 未注入：window.pi 不存在")
  return api
}

/** 发一条命令；失败抛 `IpcCallError`。 */
export async function invoke<K extends IpcChannel>(
  channel: K,
  request: IpcRequest<K>,
): Promise<IpcResponse<K>> {
  const result = (await bridge().invoke(channel, request)) as IpcResult<K>
  if (!result.ok) throw new IpcCallError(result.error.code, result.error.message)
  return result.value
}

/** 订阅一条推送；返回值是取消订阅。 */
export function subscribe<K extends PushChannel>(
  channel: K,
  listener: (payload: PushMap[K]) => void,
): () => void {
  return bridge().subscribe(channel, listener)
}
