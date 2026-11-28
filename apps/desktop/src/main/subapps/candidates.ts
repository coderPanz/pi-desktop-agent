/** 候选子应用与一次性安装 token 的主进程私有存储。 */
import { createHash, randomUUID } from "node:crypto"

import type {
  InstalledSubappManifest,
  SubappCandidateInput,
  SubappPreview,
  SubappProposal,
  SubappSmokeResult,
  SubappStaticCheck,
} from "@pi/shared-types"

export type SubappCandidate = SubappCandidateInput

export type StoredSubappCandidate = {
  id: string
  sourceHash: string
  createdAt: number
  expiresAt: number
  candidate: SubappCandidate
  preview?: Omit<SubappProposal, "candidateId">
}

type InstallToken = {
  candidateId: string
  sourceHash: string
  sender: string
  expiresAt: number
}

export type CandidateStoreOptions = {
  now?: () => number
  candidateTtlMs?: number
  tokenTtlMs?: number
}

const DEFAULT_CANDIDATE_TTL_MS = 10 * 60_000
const DEFAULT_TOKEN_TTL_MS = 60_000

function clone<T>(value: T): T {
  return structuredClone(value)
}

function candidateHash(candidate: SubappCandidate): string {
  const hash = createHash("sha256")
  hash.update(JSON.stringify(candidate.manifest), "utf8")
  hash.update("\0", "utf8")
  hash.update(candidate.files.tool, "utf8")
  hash.update("\0", "utf8")
  hash.update(candidate.files.ui ?? "", "utf8")
  hash.update("\0", "utf8")
  hash.update(candidate.files.readme ?? "", "utf8")
  return `sha256:${hash.digest("hex")}`
}

/**
 * 仅存在于主进程内存中。renderer 只能得到 preview 和 token，不能把预览后的源码重新提交给 install。
 */
export class CandidateStore {
  readonly #now: () => number
  readonly #candidateTtlMs: number
  readonly #tokenTtlMs: number
  readonly #candidates = new Map<string, StoredSubappCandidate>()
  readonly #tokens = new Map<string, InstallToken>()

  constructor(options: CandidateStoreOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#candidateTtlMs = options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
  }

  create(candidate: SubappCandidate): StoredSubappCandidate {
    this.purgeExpired()
    const createdAt = this.#now()
    const record: StoredSubappCandidate = {
      id: randomUUID(),
      sourceHash: candidateHash(candidate),
      createdAt,
      expiresAt: createdAt + this.#candidateTtlMs,
      candidate: clone(candidate),
    }
    this.#candidates.set(record.id, record)
    return clone(record)
  }

  get(id: string): StoredSubappCandidate | undefined {
    this.purgeExpired()
    const record = this.#candidates.get(id)
    return record === undefined ? undefined : clone(record)
  }

  /** 将安装器规范化 manifest、静态规则与 smoke 结果绑定到已存候选包。 */
  setPreview(input: {
    candidateId: string
    manifest: InstalledSubappManifest
    staticChecks: SubappStaticCheck[]
    smoke: SubappSmokeResult
  }): void {
    this.purgeExpired()
    const record = this.#required(input.candidateId)
    record.preview = {
      manifest: clone(input.manifest),
      staticChecks: clone(input.staticChecks),
      smoke: clone(input.smoke),
      expiresAt: record.expiresAt,
    }
  }

  /**
   * token 绑定候选内容 hash、可信 sender 和时限；同一 token 只能被 consume 一次。
   * 调用方只能在已生成 preview 后签发 token。
   */
  issueInstallToken(candidateId: string, sender: string): string {
    this.purgeExpired()
    const record = this.#required(candidateId)
    if (record.preview === undefined) throw new Error("候选子应用尚未生成安装预览。")
    const token = randomUUID()
    this.#tokens.set(token, {
      candidateId,
      sourceHash: record.sourceHash,
      sender,
      expiresAt: Math.min(record.expiresAt, this.#now() + this.#tokenTtlMs),
    })
    return token
  }

  proposal(candidateId: string): SubappProposal {
    this.purgeExpired()
    const record = this.#required(candidateId)
    if (record.preview === undefined) throw new Error("候选子应用尚未生成安装预览。")
    return { candidateId, ...clone(record.preview) }
  }

  preview(candidateId: string, sender: string): SubappPreview {
    const proposal = this.proposal(candidateId)
    const record = this.#required(candidateId)
    const installToken = this.issueInstallToken(candidateId, sender)
    return { ...proposal, files: clone(record.candidate.files), installToken }
  }

  /** 取出并立即作废 token；随后安装流程只能使用这里返回的主进程候选内容。 */
  consumeInstallToken(token: string, sender: string): StoredSubappCandidate {
    this.purgeExpired()
    const binding = this.#tokens.get(token)
    this.#tokens.delete(token)
    if (binding === undefined || binding.sender !== sender || binding.expiresAt <= this.#now()) {
      throw new Error("安装 token 无效、已过期或不属于当前调用方。")
    }
    const record = this.#required(binding.candidateId)
    if (record.sourceHash !== binding.sourceHash || record.preview === undefined) {
      throw new Error("候选子应用已变化，拒绝使用旧安装 token。")
    }
    return clone(record)
  }

  purgeExpired(): void {
    const now = this.#now()
    for (const [id, record] of this.#candidates) {
      if (record.expiresAt <= now) this.#candidates.delete(id)
    }
    for (const [token, binding] of this.#tokens) {
      if (binding.expiresAt <= now || !this.#candidates.has(binding.candidateId)) this.#tokens.delete(token)
    }
  }

  #required(id: string): StoredSubappCandidate {
    const record = this.#candidates.get(id)
    if (record === undefined || record.expiresAt <= this.#now()) {
      this.#candidates.delete(id)
      throw new Error("候选子应用不存在或已过期。")
    }
    return record
  }
}
