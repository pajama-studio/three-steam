#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultConfig, loadConfig } from './config.js'
import { doctorExitCode, runDoctor } from './doctor.js'
import { buildNativeMac, NativeOperationError, smokeNativeMac } from './native.js'
import { result, writeReport, type AgentResult, type AgentStep } from './result.js'
import { parseTarget, targetMatchesHost, targetRunner, type Target } from './target.js'
import {
  discoverRunners,
  getRemoteStatus,
  pairRunner,
  publicCredentialSummary,
  readCredential,
  runRemoteCommand,
} from '../remote/controller.js'
import { DEFAULT_DISCOVERY_PORT, DEFAULT_RUNNER_PORT } from '../remote/protocol.js'
import { startRunner, workspaceStatus } from '../remote/runner.js'

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
  build [--config path] --target target --cef-root path --steamworks-sdk path-or-zip [--build-dir path] [--json] [--report path]
  smoke [--config path] --target target [--bundle path] [--seconds 5] [--allow-no-steam] [--json] [--report path]
  pipeline [--config path] --target target [--json] [--report path]
  runner serve [--workspace path] [--listen address] [--port 47731] [--pair-code 123456] [--json]
  remote discover [--seconds 2] [--discovery-port 47732] [--json] [--report path]
  remote pair --host address --runner-id fingerprint --code 123456 [--port 47731] [--credential path] [--json] [--report path]
  remote status --credential path [--json] [--report path]
  remote run --credential path --command doctor [--json] [--report path] -- [remote command flags]
  matrix --credential path [--command doctor] [--config path] [--remote-config path] [--json] [--report path]

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

const nativeExitCode = (code: NativeOperationError['code']): number => {
  if (code === 'RUNNER_REQUIRED' || code === 'NATIVE_RUNTIME_PENDING') return 4
  if (code === 'BUILD_FAILED' || code === 'RUNTIME_VALIDATION_FAILED') return 5
  return 3
}

const emitNativeFailure = (operation: NativeOperationError): void => {
  emit(result(command, {
    ok: false,
    code: operation.code,
    summary: operation.message,
    steps: operation.steps,
    artifacts: operation.artifacts,
    nextActions: ['Fix the reported native failure and rerun the same command'],
  }))
  process.exitCode = nativeExitCode(operation.code)
}

const numberAfter = (flag: string, fallback: number): number => {
  const raw = valueAfter(flag)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number`)
  return value
}

const remoteArgsAfterSeparator = (): string[] => {
  const separator = args.indexOf('--')
  return separator < 0 ? [] : args.slice(separator + 1)
}

const runLocalJson = async (localCommand: string, localArgs: string[]): Promise<{ exitCode: number | null; result: AgentResult; stderr: string }> =>
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(process.argv[1] ?? ''), localCommand, ...localArgs, '--json'], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      try {
        const parsed = JSON.parse(stdout) as AgentResult
        resolvePromise({ exitCode, result: parsed, stderr })
      } catch {
        reject(new Error(`Local ${localCommand} did not return valid JSON: ${stderr || stdout}`))
      }
    })
  })

const safeJsonDetail = (value: unknown): string => {
  const text = JSON.stringify(value)
  return text.length <= 4_000 ? text : `${text.slice(0, 3_997)}...`
}

const emitRemoteFailure = (error: unknown, auth = false): void => {
  const message = error instanceof Error ? error.message : String(error)
  emit(result(command, {
    ok: false,
    code: auth ? 'REMOTE_AUTH_FAILED' : 'REMOTE_UNAVAILABLE',
    summary: message,
    steps: [{ id: 'remote-runner', status: 'fail', detail: message }],
    artifacts: [],
    nextActions: ['Confirm the runner is active, reachable, paired, and on the expected Git revision'],
  }))
  process.exitCode = 6
}

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(help)
  } else if (command === 'runner' && args[1] === 'serve') {
    const handle = await startRunner({
      workspace: valueAfter('--workspace') ?? process.cwd(),
      listen: valueAfter('--listen') ?? '127.0.0.1',
      port: numberAfter('--port', DEFAULT_RUNNER_PORT),
      discoveryPort: numberAfter('--discovery-port', DEFAULT_DISCOVERY_PORT),
      ...(valueAfter('--pair-code') ? { pairCode: valueAfter('--pair-code')! } : {}),
      enableDiscovery: !has('--no-discovery'),
    })
    emit(result(command, {
      ok: true,
      code: 'OK',
      summary: `Runner listening on ${handle.identity.hostname}:${handle.identity.port}`,
      steps: [
        { id: 'runner', status: 'pass', detail: safeJsonDetail(handle.identity) },
        { id: 'pairing', status: 'pass', detail: `One-time code: ${handle.pairCode}; expires in 10 minutes` },
        { id: 'workspace', status: 'pass', detail: safeJsonDetail(workspaceStatus(handle.workspace)) },
      ],
      artifacts: [],
      nextActions: [
        `On the controller: three-steam remote pair --host <runner-ip> --port ${handle.identity.port} --runner-id ${handle.identity.runnerId} --code ${handle.pairCode} --json`,
        'Keep this process running while remote commands execute',
      ],
    }))
    const close = async (): Promise<void> => {
      await handle.close()
      process.exit(0)
    }
    process.once('SIGINT', () => { void close() })
    process.once('SIGTERM', () => { void close() })
  } else if (command === 'remote' && args[1] === 'discover') {
    try {
      const runners = await discoverRunners({
        durationMs: numberAfter('--seconds', 2) * 1_000,
        discoveryPort: numberAfter('--discovery-port', DEFAULT_DISCOVERY_PORT),
      })
      emit(result(command, {
        ok: true,
        code: 'OK',
        summary: runners.length === 0 ? 'No LAN runners answered discovery' : `Discovered ${runners.length} LAN runner(s)`,
        steps: runners.map((runner) => ({
          id: runner.runnerId,
          status: runner.target === 'unsupported' ? 'warn' : 'pass',
          detail: safeJsonDetail(runner),
        })),
        artifacts: [],
        nextActions: runners.length === 0
          ? ['Check the Windows firewall, or pair directly with --host and --port']
          : ['Pair with the runner using its one-time code'],
      }))
    } catch (error) {
      emitRemoteFailure(error)
    }
  } else if (command === 'remote' && args[1] === 'pair') {
    try {
      const host = valueAfter('--host')
      const code = valueAfter('--code')
      const expectedRunnerId = valueAfter('--runner-id')
      if (!host || !code || !expectedRunnerId) throw new Error('remote pair requires --host, --runner-id, and --code')
      const paired = await pairRunner({
        host,
        code,
        expectedRunnerId,
        port: numberAfter('--port', DEFAULT_RUNNER_PORT),
        ...(valueAfter('--credential') ? { credentialPath: valueAfter('--credential')! } : {}),
      })
      emit(result(command, {
        ok: true,
        code: 'OK',
        summary: `Paired with ${paired.credential.hostname}`,
        steps: [{ id: 'pairing', status: 'pass', detail: safeJsonDetail(publicCredentialSummary(paired.credential)) }],
        artifacts: [{ kind: 'manifest', path: paired.path }],
        nextActions: [`three-steam remote status --credential ${paired.path} --json`],
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitRemoteFailure(error, /pair|code|auth/i.test(message))
    }
  } else if (command === 'remote' && args[1] === 'status') {
    try {
      const credentialPath = valueAfter('--credential')
      if (!credentialPath) throw new Error('remote status requires --credential')
      const status = await getRemoteStatus(readCredential(credentialPath))
      emit(result(command, {
        ok: true,
        code: 'OK',
        summary: `${status.runner.hostname} is online at ${status.runner.target}`,
        steps: [
          { id: 'runner', status: 'pass', detail: safeJsonDetail(status.runner) },
          { id: 'workspace', status: status.workspace.dirty ? 'warn' : 'pass', detail: safeJsonDetail(status.workspace) },
        ],
        artifacts: [],
        nextActions: ['Run a remote doctor or a two-host matrix'],
      }))
    } catch (error) {
      emitRemoteFailure(error, true)
    }
  } else if (command === 'remote' && args[1] === 'run') {
    try {
      const credentialPath = valueAfter('--credential')
      const remoteCommand = valueAfter('--command')
      if (!credentialPath || !remoteCommand) throw new Error('remote run requires --credential and --command')
      const run = await runRemoteCommand(
        readCredential(credentialPath),
        remoteCommand,
        remoteArgsAfterSeparator(),
      )
      emit(result(command, {
        ok: run.ok,
        code: run.ok ? 'OK' : 'RUNTIME_VALIDATION_FAILED',
        summary: run.ok ? `Remote ${remoteCommand} completed` : `Remote ${remoteCommand} failed with exit ${run.exitCode}`,
        steps: [{
          id: 'remote-command',
          status: run.ok ? 'pass' : 'fail',
          detail: safeJsonDetail(run.result ?? { stderr: run.stderr, stdout: run.stdout }),
        }],
        artifacts: [],
        nextActions: run.ok ? ['Inspect the remote result and continue'] : ['Fix the remote result and rerun the same command'],
      }))
      process.exitCode = run.ok ? 0 : (run.exitCode ?? 5)
    } catch (error) {
      emitRemoteFailure(error, true)
    }
  } else if (command === 'matrix') {
    try {
      const credentialPath = valueAfter('--credential')
      if (!credentialPath) throw new Error('matrix requires --credential')
      const matrixCommand = valueAfter('--command') ?? 'doctor'
      if (!new Set(['capabilities', 'doctor', 'plan', 'pipeline']).has(matrixCommand)) {
        throw new Error('matrix --command must be capabilities, doctor, plan, or pipeline')
      }
      const credential = readCredential(credentialPath)
      const status = await getRemoteStatus(credential)
      const local = workspaceStatus(process.cwd())
      const revisionsMatch = local.revision !== '' && local.revision === status.workspace.revision
      if (!revisionsMatch && !has('--allow-revision-mismatch')) {
        emit(result(command, {
          ok: false,
          code: 'REVISION_MISMATCH',
          summary: 'Local and remote Git revisions do not match',
          steps: [
            { id: 'local-revision', status: 'fail', detail: String(local.revision || 'unknown') },
            { id: 'remote-revision', status: 'fail', detail: String(status.workspace.revision || 'unknown') },
          ],
          artifacts: [],
          nextActions: ['Pull or checkout the same commit on both hosts, then rerun matrix'],
        }))
        process.exitCode = 7
      } else {
        if (local.target === 'unsupported' || status.workspace.target === 'unsupported') {
          throw new Error('Matrix requires a supported macOS or Windows x64 host on each side')
        }
        const localArgs = matrixCommand === 'capabilities' ? [] : [
          '--config', valueAfter('--config') ?? configPath,
          '--target', String(local.target),
        ]
        const remoteArgs = matrixCommand === 'capabilities' ? [] : [
          '--config', valueAfter('--remote-config') ?? 'three-steam.config.example.json',
          '--target', String(status.workspace.target),
        ]
        const [localRun, remoteRun] = await Promise.all([
          runLocalJson(matrixCommand, localArgs),
          runRemoteCommand(credential, matrixCommand, remoteArgs),
        ])
        const detailDir = resolve('artifacts', 'matrix')
        mkdirSync(detailDir, { recursive: true })
        const detailPath = join(detailDir, `${Date.now()}-${matrixCommand}.json`)
        writeFileSync(detailPath, `${JSON.stringify({
          schemaVersion: 1,
          revisionsMatch,
          localStatus: local,
          remoteStatus: status,
          local: localRun,
          remote: remoteRun,
        }, null, 2)}\n`)
        const ok = localRun.result.ok && remoteRun.ok
        emit(result(command, {
          ok,
          code: ok ? 'OK' : 'RUNTIME_VALIDATION_FAILED',
          summary: ok ? `${matrixCommand} passed on both hosts` : `${matrixCommand} did not pass on both hosts`,
          steps: [
            { id: 'revision', status: revisionsMatch ? 'pass' : 'warn', detail: revisionsMatch ? String(local.revision) : 'Revision mismatch explicitly allowed' },
            { id: 'local', status: localRun.result.ok ? 'pass' : 'fail', detail: safeJsonDetail(localRun.result) },
            { id: 'remote', status: remoteRun.ok ? 'pass' : 'fail', detail: safeJsonDetail(remoteRun.result) },
          ],
          artifacts: [{ kind: 'report', path: detailPath }],
          nextActions: ok ? ['Continue with target-native build and smoke gates'] : ['Open the matrix detail report and fix the failing host'],
        }))
        process.exitCode = ok ? 0 : 5
      }
    } catch (error) {
      emitRemoteFailure(error)
    }
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
        { id: 'macos-arm64', status: 'pending', detail: 'macos-14 arm64 runner; native build and accelerated smoke available, full P0 pending' },
        { id: 'macos-x64', status: 'pending', detail: 'macos-15-intel x64 runner; native build and accelerated smoke available, real-hardware P0 pending' },
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
  } else if (command === 'build') {
    const target = parseTarget(valueAfter('--target'))
    if (!targetMatchesHost(target)) {
      emitNativeFailure(new NativeOperationError(
        'RUNNER_REQUIRED',
        `${target} must run on ${targetRunner(target)}`,
        [{ id: 'target-runner', status: 'fail', detail: `Current host is ${process.platform}-${process.arch}` }],
      ))
    } else {
      try {
        const output = buildNativeMac({
          loaded: loadConfig(configPath),
          target,
          ...(valueAfter('--cef-root') ? { cefRoot: valueAfter('--cef-root')! } : {}),
          ...(valueAfter('--steamworks-sdk') ? { steamworksSdk: valueAfter('--steamworks-sdk')! } : {}),
          ...(valueAfter('--build-dir') ? { buildDir: valueAfter('--build-dir')! } : {}),
        })
        emit(result(command, {
          ok: true,
          code: 'OK',
          summary: `Built and signed ${target} native app bundle`,
          steps: output.steps,
          artifacts: output.artifacts,
          nextActions: [
            `three-steam smoke --config ${resolve(configPath)} --target ${target} --bundle ${output.appPath} --json --report artifacts/${target}/smoke.json`,
          ],
        }))
      } catch (error) {
        if (error instanceof NativeOperationError) emitNativeFailure(error)
        else throw error
      }
    }
  } else if (command === 'smoke') {
    const target = parseTarget(valueAfter('--target'))
    if (!targetMatchesHost(target)) {
      emitNativeFailure(new NativeOperationError(
        'RUNNER_REQUIRED',
        `${target} must run on ${targetRunner(target)}`,
        [{ id: 'target-runner', status: 'fail', detail: `Current host is ${process.platform}-${process.arch}` }],
      ))
    } else {
      try {
        const seconds = Number(valueAfter('--seconds') ?? '5')
        const output = smokeNativeMac({
          loaded: loadConfig(configPath),
          target,
          ...(valueAfter('--bundle') ? { bundlePath: valueAfter('--bundle')! } : {}),
          ...(valueAfter('--output-dir') ? { outputDir: valueAfter('--output-dir')! } : {}),
          seconds,
          allowNoSteam: has('--allow-no-steam'),
        })
        emit(result(command, {
          ok: true,
          code: 'OK',
          summary: `Validated ${target} accelerated native runtime`,
          steps: output.steps,
          artifacts: output.artifacts,
          nextActions: output.report.steamAvailable
            ? ['Continue with target-hardware Overlay, capture, input, resize and performance gates']
            : ['Start Steam and rerun without --allow-no-steam before any Steam integration claim'],
        }))
      } catch (error) {
        if (error instanceof NativeOperationError) emitNativeFailure(error)
        else throw error
      }
    }
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
