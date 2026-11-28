/**
 * 子应用跨进程契约。
 *
 * 本文件不依赖 pi-durable：渲染进程只能看到这些 JSON 形状，不能接触主进程的装载器或源码。
 */

/** 当前落盘 manifest 的格式版本。升级格式时新增联合分支，不修改既有语义。 */
export type SubappSchemaVersion = 1

/** 用户申请的能力；M1 只接受只读申请，真正强制执行从 M3 开始。 */
export type RequestedSubappCapabilities = {
  tools: string[]
  readPaths: string[]
  writePaths: string[]
  network: boolean
  runsCommands: boolean
}

/** M2 UI 的静态入口声明；UI 内容仍须经主进程 DSL 校验。 */
export type SubappUiDeclaration = {
  kind: "dsl"
  dslVersion: 1
  icon?: string
}

/** 模型生成、尚未由安装器赋予版本与校验和的候选 manifest。 */
export type SubappManifestDraft = {
  schemaVersion: SubappSchemaVersion
  slug: string
  title: string
  requestedCapabilities: RequestedSubappCapabilities
  ui?: SubappUiDeclaration
}

/** 安装器规范化候选包后实际写入版本目录的 manifest。 */
export type InstalledSubappManifest = SubappManifestDraft & {
  version: number
  createdAt: number
  /** 安装器写入；候选包不得自行声称已隔离。 */
  enforcement: SubappEnforcement
  checksum: string
}

/** 当前真实执行保障，而不是用户申请能力。 */
export type SubappEnforcement = "m1-local-confirmed" | "sandbox-profile"

export type SubappStatus = "ready" | "failed" | "disabled"
export type SubappSmokeStatus = "passed" | "failed" | "skipped"

/** `app.subapps` 中的一项；session 作用域，重启后以它选择需加载的版本。 */
export type AppSubapp = {
  slug: string
  title: string
  version: number
  /** 最近一次可恢复的版本；首次安装时不存在。 */
  previousVersion?: number
  enabled: boolean
  status: SubappStatus
  error?: string
  requestedCapabilities: RequestedSubappCapabilities
  enforcement: SubappEnforcement
  smoke: SubappSmokeStatus
  installedAt: number
}

export type AppSubapps = {
  items: AppSubapp[]
}

/** 安装确认页展示的单项静态规则结果。 */
export type SubappStaticCheck = {
  rule: string
  status: "passed" | "failed"
  message?: string
}

/** smoke 只证明最小调用链可运行，不能用作安全结论。 */
export type SubappSmokeResult = {
  status: SubappSmokeStatus
  durationMs?: number
  summary?: string
}

/** `subapp.preview` 的返回值；token 只能交回 `subapp.install`，不能携带源码重装。 */
export type SubappProposal = {
  candidateId: string
  manifest: InstalledSubappManifest
  staticChecks: SubappStaticCheck[]
  smoke: SubappSmokeResult
  expiresAt: number
}

/** 安装确认页的数据；只有可信 renderer 通过 candidateId 拉取时才签发 installToken。 */
export type SubappPreview = SubappProposal & {
  files: SubappVersionFiles
  installToken: string
}

/** 版本目录中会被安装器写入的文件内容。 */
export type SubappVersionFiles = {
  tool: string
  ui?: string
  readme?: string
}

/** 主进程在预览前接收的候选包；安装后不再相信 renderer 回传的同类内容。 */
export type SubappCandidateInput = {
  manifest: SubappManifestDraft
  files: SubappVersionFiles
}

/** 主进程推送给 renderer 的轻量状态变化；需要完整列表时重新调用 subapp.list。 */
export type SubappChanged = {
  slug: string
  status?: SubappStatus
  removed?: boolean
}
