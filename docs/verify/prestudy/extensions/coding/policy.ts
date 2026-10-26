import path from "node:path";

/** 审批结论。 */
export type Decision = "allow" | "ask" | "deny";

/** 一次待审批调用需要的最小信息。 */
export type PolicyInput = {
  /** 工具名，例如 bash、write_file。 */
  tool: string;
  /** bash 的命令文本。 */
  command?: string;
  /** 文件类工具的路径参数。 */
  path?: string;
  /** 工作区根目录，用于判断路径是否越界。 */
  workspaceRoot: string;
};

/** 带原因的结论，便于写进 block 文案。 */
export type PolicyResult = { decision: Decision; reason?: string };

/** 绝对拒执行的命令模式。 */
const DENY_COMMANDS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/i, reason: "递归删除根目录" },
  { pattern: /\bmkfs(\.|\s)/i, reason: "格式化文件系统" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "直接写块设备" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "关机或重启" },
  { pattern: /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: "下载后直接执行脚本" },
  { pattern: /\bchmod\s+-R\s+777\s+\//i, reason: "递归放开根目录权限" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork 炸弹" },
  { pattern: />\s*\/dev\/sd[a-z]/i, reason: "覆盖磁盘设备" },
];

/** 需要用户确认的命令模式。 */
const ASK_COMMANDS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\b/i, reason: "删除文件" },
  { pattern: /\bgit\s+push\b/i, reason: "推送到远端仓库" },
  { pattern: /\b(npm|pnpm|yarn)\s+(install|i|add)\b/i, reason: "安装依赖" },
  { pattern: /\b(sudo|doas)\b/i, reason: "提权执行" },
  { pattern: /\b(apt|apt-get|brew|dnf|yum|pacman)\s+(install|remove|upgrade)\b/i, reason: "系统级包管理" },
  { pattern: /\bkill\s+-9\b/i, reason: "强制结束进程" },
];

/** 绝对不能落的路径片段。 */
const DENY_PATH_SEGMENTS: readonly { value: string; reason: string }[] = [
  { value: ".ssh", reason: "包含 SSH 私钥" },
  { value: ".aws", reason: "包含云凭证" },
  { value: ".gnupg", reason: "包含 GPG 私钥" },
  { value: ".netrc", reason: "包含登录凭证" },
];

const severity: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

const worse = (a: PolicyResult, b: PolicyResult): PolicyResult => (severity[b.decision] > severity[a.decision] ? b : a);

/** 把一条命令按 ; && || | 拆成独立片段，避免「前面安全、后面危险」漏判。 */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 路径策略：越界直接拒绝，敏感目录拒绝，写 .env 需要确认。 */
function classifyPath(input: PolicyInput): PolicyResult {
  const raw = input.path?.trim();
  if (raw === undefined || raw === "") return { decision: "allow" };

  const normalized = raw.split(/[\\/]+/).filter((part) => part.length > 0);
  for (const segment of DENY_PATH_SEGMENTS) {
    if (normalized.includes(segment.value)) return { decision: "deny", reason: `拒绝访问 ${segment.value}：${segment.reason}` };
  }

  if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(input.workspaceRoot), path.resolve(raw));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { decision: "deny", reason: `路径超出工作区：${raw}` };
    }
  } else {
    const relative = path.relative(path.resolve(input.workspaceRoot), path.resolve(input.workspaceRoot, raw));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { decision: "deny", reason: `路径超出工作区：${raw}` };
    }
  }

  if (input.tool === "write_file" && normalized.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    return { decision: "ask", reason: "写入环境变量文件" };
  }
  return { decision: "allow" };
}

/** 命令策略：逐片段判定，取最严重的一个。 */
function classifyCommand(input: PolicyInput): PolicyResult {
  const command = input.command?.trim();
  if (command === undefined || command === "") return { decision: "allow" };

  // 危险模式先看整条命令：`curl ... | sh` 被拆段后会丢失管道关系。
  for (const rule of DENY_COMMANDS) {
    if (rule.pattern.test(command)) return { decision: "deny", reason: rule.reason };
  }

  let result: PolicyResult = { decision: "allow" };
  for (const fragment of splitCommand(command)) {
    // 逐段再查一遍，防止拼接绕过（如 `ls; rm -rf /`）。
    for (const rule of DENY_COMMANDS) {
      if (rule.pattern.test(fragment)) return { decision: "deny", reason: rule.reason };
    }
    for (const rule of ASK_COMMANDS) {
      if (rule.pattern.test(fragment)) result = worse(result, { decision: "ask", reason: rule.reason });
    }
  }
  return result;
}

/**
 * 纯函数：不读文件、不访问环境，便于单测。
 * 只看 bash 的命令文本与文件工具的路径，其他工具一律放行。
 */
export function classify(input: PolicyInput): PolicyResult {
  const byPath = classifyPath(input);
  if (byPath.decision === "deny") return byPath;

  const byCommand = input.tool === "bash" ? classifyCommand(input) : { decision: "allow" as Decision };
  if (byCommand.decision === "deny") return byCommand;

  return worse(byPath, byCommand);
}
