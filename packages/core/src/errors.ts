/**
 * 错误分类
 * - `UserError`：当前状态不满足操作前提（会话不存在、没有可 fork 的条目）
 * - `ConfigError`：环境或配置缺失（没有 `ANTHROPIC_MODEL`、没有可用凭证）
 */

/** 调用方输入或当前状态不满足前提-可展示给用户。 */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserError"
  }
}

/** 配置或环境缺失 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}
