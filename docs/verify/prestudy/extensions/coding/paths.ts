import path from "node:path";

/**
 * 把用户给的路径解析到工作区内，越界直接抛错。
 * 用 path.relative 判断，而不是字符串 startsWith（`/root2` 会被 `/root` 误判）。
 */
export function resolveInside(root: string, userPath: string): string {
  const trimmed = userPath.trim();
  if (trimmed === "") throw new Error("路径不能为空");
  if (path.isAbsolute(trimmed)) throw new Error(`不接受绝对路径：${userPath}`);

  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, trimmed);
  const relative = path.relative(absoluteRoot, target);

  if (relative === "") return target;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径超出工作区：${userPath}`);
  }
  return target;
}

/** 把工作区内的绝对路径转成便于展示的相对路径。 */
export function displayPath(root: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(root), absolutePath);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}
