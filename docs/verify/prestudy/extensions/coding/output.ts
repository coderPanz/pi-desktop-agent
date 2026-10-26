import type { TextContent } from "@earendil-works/pi-ai";

/** 把纯文本包成工具输出的内容块数组。 */
export function textOutput(text: string): TextContent[] {
  return [{ type: "text", text }];
}
