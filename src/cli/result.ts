import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const AGENT_RESULT_SCHEMA_VERSION = 1 as const

export type AgentErrorCode =
  | 'CONFIG_INVALID'
  | 'NATIVE_RUNTIME_PENDING'
  | 'PREREQUISITE_FAILED'
  | 'RUNNER_REQUIRED'
  | 'UNKNOWN_COMMAND'

export interface AgentStep {
  id: string
  status: 'pass' | 'warn' | 'fail' | 'pending' | 'skipped'
  detail: string
}

export interface AgentArtifact {
  kind: 'binary' | 'bundle' | 'log' | 'manifest' | 'report'
  path: string
  target?: string
  sha256?: string
}

export interface AgentResult {
  schemaVersion: typeof AGENT_RESULT_SCHEMA_VERSION
  command: string
  ok: boolean
  code: 'OK' | AgentErrorCode
  summary: string
  steps: AgentStep[]
  artifacts: AgentArtifact[]
  nextActions: string[]
}

export function result(
  command: string,
  values: Omit<AgentResult, 'schemaVersion' | 'command'>,
): AgentResult {
  return { schemaVersion: AGENT_RESULT_SCHEMA_VERSION, command, ...values }
}

export function writeReport(reportPath: string | undefined, value: AgentResult): string | undefined {
  if (!reportPath) return undefined
  const absolute = resolve(reportPath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
  return absolute
}
