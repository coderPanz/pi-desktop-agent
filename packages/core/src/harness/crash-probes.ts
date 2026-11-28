import { GenerationTask, LiveDoc, ToolResultEntry, ToolTask, hook } from "@earendil-works/pi-durable"
import type { CommitPublication, Extension, Harness } from "@earendil-works/pi-durable"
import { isJsonObject } from "@pi/shared-types"

import { configuredCrashPoint, crashPoint } from "../dev/crash-point.ts"

/** 只在显式开启故障注入时安装；afterTool 在副作用完成后、工具结果提交之前。 */
export function crashProbeExtension(): Extension | undefined {
  if (configuredCrashPoint() !== "during-tool") return undefined
  return {
    name: "app.crash-probes",
    hooks: [hook(ToolTask, {
      afterTool() { crashPoint("during-tool"); return undefined },
    })],
  }
}

/** 根据已提交状态注入强杀，不能用 afterResponse 冒充“流式中”或“结果已落库”。 */
export function probeCommittedState(publication: CommitPublication): void {
  for (const change of publication.changes) {
    if (change.type === "submission" && change.value.type === "input" && (change.value.status === "queued" || change.value.status === "placed")) {
      crashPoint("after-submit")
    }
    if (change.type === "entry" && ToolResultEntry.is(change.value)) {
      crashPoint("after-tool-result")
    }
    if (change.type === "task" && change.value.kind === GenerationTask.definition.name) {
      const state = change.value.state
      if (state.status === "running" && isJsonObject(state.checkpoint) && state.checkpoint.phase === "request") {
        crashPoint("between-phases")
      }
    }
    if (change.type === "document" && change.record.kind === LiveDoc.definition.kind && change.value !== null) {
      const generation = change.value.generation
      if (isJsonObject(generation) && isJsonObject(generation.message)) {
        const content = generation.message.content
        if (Array.isArray(content) && content.some(block => isJsonObject(block) && (
          (typeof block.text === "string" && block.text.length > 0) ||
          (typeof block.thinking === "string" && block.thinking.length > 0)
        ))) crashPoint("mid-generation")
      }
    }
  }
}

export function attachCrashProbes(harness: Harness): void {
  if (configuredCrashPoint() === undefined) return
  const stop = harness.subscribeCommits(probeCommittedState)
  void harness.closed.then(stop)
}
