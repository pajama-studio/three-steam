#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultConfig, loadConfig } from './config.js'
import { doctorExitCode, runDoctor } from './doctor.js'
import { result, writeReport, type AgentResult, type AgentStep } from './result.js'
import { parseTarget, targetMatchesHost, targetRunner, type Target } from './target.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const has = (flag: string): boolean => args.includes(flag)
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const configPath = valueAfter('--config') ?? 'three-steam.config.json'
const reportPath = valueAfter('--report')
const json = has('--json')

const help = `three-steam

Commands:
  init [--config path] [--json]
  capabilities [--json]
  doctor [--config path] [--target target] [--json] [--report path]
  plan [--config path] [--target target] [--json] [--report path]
  pipeline [--config path] --target target [--json] [--report path]

Targets: windows-x64, macos-arm64, macos-x64
Agent rule: use --json and --report for every non-interactive run.
`

const emit = (value: AgentResult, human?: string): void => {
  const report = writeReport(reportPath, value)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...value, report: report ?? null })}\n`)
  } else {
    process.stdout.write(human ?? `${value.ok ? 'PASS' : 'FAIL'} ${value.summary}\n`)
    if (report) process.stdout.write(`Report: ${report}\n`)
  }
}

const basePlan = (target: Target, entry: string): AgentStep[] => [
  { id: 'web-assets', status: 'pending', detail: `Validate immutable game bundle at ${entry}` },
  { id: 'bridge-tests', status: 'pending', detail: 'Run typed bridge and protocol contract tests' },
  { id: 'native-core', status: 'pending', detail: `Compile protocol core on ${targetRunner(target)}` },
  {
    id: 'native-runtime',
    status: 'pending',
    detail: target === 'windows-x64'
      ? 'Build Win32 + CEF accelerated OSR + D3D11 + Steamworks host'
      : 'Build Cocoa + CEF accelerated OSR + Metal + Steamworks host',
  },
  { id: 'runtime-tests', status: 'pending', detail: 'Run renderer, lifecycle, input and Steam smoke suite' },
  { id: 'package', status: 'pending', detail: `Create deterministic ${target} Steam depot bundle and SHA-256 manifest` },
]

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(help)
  } else if (command === 'init') {
    const output = resolve(configPath)
    if (existsSync(output)) throw new Error(`${output} already exists`)
    writeFileSync(output, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { flag: 'wx' })
    emit(result(command, {
      ok: true,
      code: 'OK',
      summary: `Created ${output}`,
      steps: [{ id: 'config', status: 'pass', detail: output }],
      artifacts: [{ kind: 'manifest', path: output }],
      nextActions: [`three-steam doctor --config ${output} --json`],
    }))
  } else if (command === 'capabilities') {
    emit(result(command, {
      ok: true,
      code: 'OK',
      summary: 'Platform support and runner requirements',
      steps: [
        { id: 'windows-x64', status: 'pending', detail: 'windows-2022 x64 runner; D3D11 runtime implementation in progress' },
        { id: 'macos-arm64', status: 'pending', detail: 'macos-14 arm64 runner; Metal runtime planned after Windows P0' },
        { id: 'macos-x64', status: 'pending', detail: 'macos-15-intel x64 runner; Metal runtime planned after Windows P0' },
      ],
      artifacts: [],
      nextActions: ['Run pipeline on the target-native runner; do not cross-compile release hosts'],
    }))
  } else if (command === 'doctor') {
    const target = parseTarget(valueAfter('--target'))
    const checks = runDoctor(loadConfig(configPath), target)
    const failed = doctorExitCode(checks) !== 0
    const steps: AgentStep[] = checks.map((check) => ({
      id: check.id,
      status: check.status,
      detail: check.message,
    }))
    if (!targetMatchesHost(target)) {
      steps.push({ id: 'target-runner', status: 'warn', detail: `${target} requires ${targetRunner(target)}` })
    }
    const value = result(command, {
      ok: !failed,
      code: failed ? 'PREREQUISITE_FAILED' : 'OK',
      summary: failed ? `Prerequisites failed for ${target}` : `Doctor completed for ${target}`,
      steps,
      artifacts: [],
      nextActions: failed ? ['Fix failed checks and rerun doctor'] : [`three-steam plan --target ${target} --json`],
    })
    emit(value)
    process.exitCode = failed ? 3 : 0
  } else if (command === 'plan') {
    const target = parseTarget(valueAfter('--target'))
    const loaded = loadConfig(configPath)
    emit(result(command, {
      ok: true,
      code: 'OK',
      summary: `Deterministic ${target} build plan`,
      steps: basePlan(target, loaded.entryPath),
      artifacts: [],
      nextActions: targetMatchesHost(target)
        ? [`three-steam pipeline --target ${target} --json --report artifacts/${target}/report.json`]
        : [`Run the same command on ${targetRunner(target)}`],
    }))
  } else if (command === 'pipeline') {
    const target = parseTarget(valueAfter('--target'))
    const loaded = loadConfig(configPath)
    const checks = runDoctor(loaded, target)
    if (doctorExitCode(checks) !== 0) {
      emit(result(command, {
        ok: false,
        code: 'PREREQUISITE_FAILED',
        summary: `Cannot start ${target} pipeline`,
        steps: checks.map((check) => ({ id: check.id, status: check.status, detail: check.message })),
        artifacts: [],
        nextActions: ['Fix doctor failures and rerun pipeline with the same report path'],
      }))
      process.exitCode = 3
    } else if (!targetMatchesHost(target)) {
      emit(result(command, {
        ok: false,
        code: 'RUNNER_REQUIRED',
        summary: `${target} must run on ${targetRunner(target)}`,
        steps: basePlan(target, loaded.entryPath).map((step) => ({ ...step, status: 'skipped' })),
        artifacts: [],
        nextActions: [`Dispatch this command to ${targetRunner(target)}`],
      }))
      process.exitCode = 4
    } else {
      emit(result(command, {
        ok: false,
        code: 'NATIVE_RUNTIME_PENDING',
        summary: `${target} native runtime is not release-complete yet`,
        steps: basePlan(target, loaded.entryPath),
        artifacts: [],
        nextActions: ['Implement the target runtime, then replace this guard only after P0 validation gates pass'],
      }))
      process.exitCode = 4
    }
  } else {
    emit(result(command, {
      ok: false,
      code: 'UNKNOWN_COMMAND',
      summary: `Unknown command: ${command}`,
      steps: [],
      artifacts: [],
      nextActions: ['Run three-steam help'],
    }), `Unknown command: ${command}\n\n${help}`)
    process.exitCode = 2
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  emit(result(command, {
    ok: false,
    code: 'CONFIG_INVALID',
    summary: message,
    steps: [{ id: 'input', status: 'fail', detail: message }],
    artifacts: [],
    nextActions: ['Fix command arguments/configuration and retry'],
  }), `${message}\n`)
  process.exitCode = 2
}
