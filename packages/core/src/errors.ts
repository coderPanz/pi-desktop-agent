/**
 * core 的错误分类。
 *
 * 分三类，因为调用方对它们的处理完全不同：
 *
 * - `UserError`：当前状态不满足操作前提（会话不存在、没有可 fork 的条目）。
 * - `ConfigError`：环境或配置缺失（没有 `ANTHROPIC_MODEL`、没有可用凭证）。启动期即失败，重试没有意义，必须改配置。
 * - 存储类错误：不在这里定义：`pi-durable` 的 `SessionFailed` 意味着 Harness 已经不可用，
 */

/** 调用方输入或当前状态不满足前提。可展示给用户，不改变进程健康状态。 */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserError"
  }
}

/** 配置或环境缺失：必须改配置才能继续。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}
