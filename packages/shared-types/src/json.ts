/**
 * 严格 JSON 的结构与守卫
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 递归判断：从文件里读出的值可能来自更早的版本，取用前必须能证明它是严格 JSON。 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  switch (typeof value) {
    case "boolean":
    case "string":
      return true
    case "number":
      return Number.isFinite(value)
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue)
      for (const item of Object.values(value)) {
        if (!isJsonValue(item)) return false
      }
      return true
    }
    default:
      return false
  }
}
