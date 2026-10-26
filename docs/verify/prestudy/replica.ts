import { applyImmutable, isBase, type Op } from "@earendil-works/chord/delta";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

/** 本地副本类型：与会话视图一致。 */
export type Replica = ConversationView;

/** 应用一帧：空帧不动、整帧覆盖、增量帧合并，都不修改旧副本。 */
export function applyFrame(prev: Replica | undefined, ops: readonly Op[]): Replica | undefined {
  if (ops.length === 0) return prev;
  return isBase(ops) ? applyImmutable<Replica>(undefined, ops) : applyImmutable(prev, ops);
}

/** 从模型内容块数组里取纯文本。 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** 读实时文档里正在生成的文本。 */
export function liveText(view: Replica): string {
  const live = view.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined;
  return textFromContent(live?.generation?.message?.content);
}

/** 读某条 entry 的文本。 */
export function entryText(entry: EntryRecord | undefined): string {
  return textFromContent(entry?.model?.[0]?.content);
}

/** 读当前应显示的文本：生成中优先实时，落盘后用正式 entry。 */
export function displayedText(view: Replica): string {
  const live = liveText(view);
  if (live) return live;
  return entryText(view.entries.filter((entry) => entry.kind === "pi.assistant").at(-1));
}
