import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadedConfig } from './config.js'
import type { AgentArtifact, AgentErrorCode, AgentStep } from './result.js'
import { targetMatchesHost, type Target } from './target.js'

export interface NativeBuildOptions {
  loaded: LoadedConfig
  target: Target
  cefRoot?: string
  steamworksSdk?: string
  buildDir?: string
}

export interface NativeBuildResult {
  steps: AgentStep[]
  artifacts: AgentArtifact[]
  appPath: string
  executablePath: string
  steamworksSdkRoot: string
}

export interface NativeSmokeOptions {
  loaded: LoadedConfig
  target: Target
  bundlePath?: string
  outputDir?: string
  seconds: number
  allowNoSteam: boolean
}

export interface RuntimeReport {
  schemaVersion: 1
  renderer: 'metal'
  steamAvailable: boolean
  pageLoaded: boolean
  loadFailed: boolean
  acceleratedCallbacks: number
  presentedFrames: number
  presentFailures: number
  cpuPaintFrames: number
}

export class NativeOperationError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly steps: AgentStep[],
    public readonly artifacts: AgentArtifact[] = [],
  ) {
    super(message)
  }
}

const nativeSourceDir = resolve(fileURLToPath(new URL('../../native/host/', import.meta.url)))

const command = (
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string => {
  const run = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.error || run.status !== 0) {
    const tail = output.trim().split('\n').slice(-30).join('\n')
    throw new Error(`${basename(executable)} failed (${run.status ?? 'no exit'}): ${run.error?.message ?? tail}`)
  }
  return output
}

const steamworksRootIsValid = (directory: string): boolean =>
  existsSync(join(directory, 'public', 'steam', 'steam_api.h')) &&
  existsSync(join(directory, 'redistributable_bin', 'osx', 'libsteam_api.dylib'))

export function findSteamworksSdkRoot(directory: string, depth = 3): string | undefined {
  const absolute = resolve(directory)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return undefined
  if (steamworksRootIsValid(absolute)) return absolute
  if (depth === 0) return undefined
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const found = findSteamworksSdkRoot(join(absolute, entry.name), depth - 1)
    if (found) return found
  }
  return undefined
}

const prepareSteamworksSdk = (input: string, dependencyDir: string): string => {
  const absolute = resolve(input)
  if (!existsSync(absolute)) throw new Error(`Steamworks SDK path does not exist: ${absolute}`)
  if (statSync(absolute).isDirectory()) {
    const found = findSteamworksSdkRoot(absolute)
    if (!found) throw new Error(`Steamworks SDK directory is incomplete: ${absolute}`)
    return found
  }
  if (!absolute.toLowerCase().endsWith('.zip')) {
    throw new Error('Steamworks SDK must be an extracted directory or Valve-provided .zip')
  }

  const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 16)
  const extractionRoot = join(dependencyDir, `steamworks-${digest}`)
  const cached = findSteamworksSdkRoot(extractionRoot)
  if (cached) return cached

  rmSync(extractionRoot, { recursive: true, force: true })
  mkdirSync(extractionRoot, { recursive: true })
  command('/usr/bin/ditto', ['-x', '-k', absolute, extractionRoot])
  const extracted = findSteamworksSdkRoot(extractionRoot)
  if (!extracted) throw new Error('The Steamworks archive did not contain a complete macOS SDK')
  return extracted
}

const cefRootIsValid = (directory: string): boolean =>
  existsSync(join(directory, 'cmake', 'FindCEF.cmake')) &&
  existsSync(join(directory, 'Release', 'Chromium Embedded Framework.framework'))

const hashTreeEntry = (hash: ReturnType<typeof createHash>, root: string, relative: string): void => {
  const absolute = join(root, relative)
  const info = lstatSync(absolute)
  hash.update(relative)
  hash.update('\0')
  if (info.isSymbolicLink()) {
    hash.update('link\0')
    hash.update(readlinkSync(absolute))
    return
  }
  if (info.isDirectory()) {
    hash.update('dir\0')
    for (const name of readdirSync(absolute).sort()) {
      hashTreeEntry(hash, root, join(relative, name))
    }
    return
  }
  hash.update('file\0')
  hash.update(readFileSync(absolute))
}

export function hashTree(path: string): string {
  const absolute = resolve(path)
  const hash = createHash('sha256')
  hashTreeEntry(hash, absolute, '.')
  return hash.digest('hex')
}

export function buildNativeMac(options: NativeBuildOptions): NativeBuildResult {
  const { loaded, target } = options
  if (!targetMatchesHost(target)) {
    throw new NativeOperationError('RUNNER_REQUIRED', `${target} does not match this host`, [])
  }
  if (target === 'windows-x64') {
    throw new NativeOperationError('NATIVE_RUNTIME_PENDING', 'The Windows D3D11 host is not implemented yet', [])
  }

  const steps: AgentStep[] = []
  const cefRoot = resolve(options.cefRoot ?? process.env.CEF_ROOT ?? '')
  if (!cefRootIsValid(cefRoot)) {
    throw new NativeOperationError('PREREQUISITE_FAILED', `Invalid CEF_ROOT: ${cefRoot}`, [
      { id: 'cef', status: 'fail', detail: 'Provide an extracted macOS CEF minimal distribution with --cef-root' },
    ])
  }
  steps.push({ id: 'cef', status: 'pass', detail: cefRoot })

  const buildDir = resolve(options.buildDir ?? join(loaded.projectDir, 'build', `three-steam-${target}`))
  const dependencyDir = join(buildDir, 'dependencies')
  const steamworksInput = options.steamworksSdk ?? process.env.STEAMWORKS_SDK
  if (!steamworksInput) {
    throw new NativeOperationError('PREREQUISITE_FAILED', 'Steamworks SDK is required', [
      ...steps,
      { id: 'steamworks', status: 'fail', detail: 'Pass --steamworks-sdk /path/to/sdk-or-zip' },
    ])
  }

  let steamworksSdkRoot: string
  try {
    steamworksSdkRoot = prepareSteamworksSdk(steamworksInput, dependencyDir)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new NativeOperationError('PREREQUISITE_FAILED', detail, [
      ...steps,
      { id: 'steamworks', status: 'fail', detail },
    ])
  }
  steps.push({ id: 'steamworks', status: 'pass', detail: steamworksSdkRoot })

  mkdirSync(buildDir, { recursive: true })
  const architecture = target === 'macos-arm64' ? 'arm64' : 'x86_64'
  const environment = { ...process.env, CEF_ROOT: cefRoot, STEAMWORKS_SDK: steamworksSdkRoot }
  try {
    command('cmake', [
      '-S', nativeSourceDir,
      '-B', buildDir,
      '-G', 'Xcode',
      '-DTHREE_STEAM_BUILD_WINDOWS_HOST=OFF',
      '-DTHREE_STEAM_BUILD_MAC_HOST=ON',
      `-DTHREE_STEAM_GAME_DIR=${loaded.gameDir}`,
      `-DTHREE_STEAM_GAME_ENTRY=${loaded.config.entry}`,
      `-DTHREE_STEAM_WINDOW_TITLE=${loaded.config.title}`,
      `-DTHREE_STEAM_WINDOW_WIDTH=${loaded.config.window.width}`,
      `-DTHREE_STEAM_WINDOW_HEIGHT=${loaded.config.window.height}`,
      `-DTHREE_STEAM_WINDOW_RESIZABLE=${loaded.config.window.resizable ? '1' : '0'}`,
      `-DCMAKE_OSX_ARCHITECTURES=${architecture}`,
    ], { env: environment })
    steps.push({ id: 'configure', status: 'pass', detail: buildDir })
    command('cmake', [
      '--build', buildDir,
      '--config', 'Release',
      '--target', 'three-steam-host',
      '--parallel', '8',
    ], { env: environment })
    steps.push({ id: 'compile', status: 'pass', detail: `${target} Release host` })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new NativeOperationError('BUILD_FAILED', detail, [
      ...steps,
      { id: 'compile', status: 'fail', detail },
    ])
  }

  const appPath = join(buildDir, 'Release', 'three-steam-host.app')
  const executablePath = join(appPath, 'Contents', 'MacOS', 'three-steam-host')
  if (!existsSync(executablePath)) {
    throw new NativeOperationError('BUILD_FAILED', `Native executable is missing: ${executablePath}`, steps)
  }
  try {
    const contents = join(appPath, 'Contents')
    const framework = join(contents, 'Frameworks', 'Chromium Embedded Framework.framework')
    const frameworkVersion = join(framework, 'Versions', 'A')
    const helpers = readdirSync(join(contents, 'Frameworks'))
      .filter((name) => name.startsWith('three-steam-host Helper') && name.endsWith('.app'))
      .sort()
    // Signing the top-level versioned framework path can cause codesign to
    // materialize its public symlinks inside Versions/A on repeated ad-hoc
    // builds. Those self-links make subsequent deep verification fail. Sign
    // the concrete framework version and defensively remove only those known
    // generated links first.
    for (const staleLink of [
      join(frameworkVersion, 'A'),
      join(frameworkVersion, 'Libraries', 'Libraries'),
      join(frameworkVersion, 'Resources', 'Resources'),
    ]) {
      try {
        if (lstatSync(staleLink).isSymbolicLink()) rmSync(staleLink, { force: true })
      } catch {
        // The normal first-build case: the stale link does not exist.
      }
    }
    command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', frameworkVersion])
    for (const helper of helpers) {
      command('/usr/bin/codesign', [
        '--force', '--deep', '--sign', '-', '--timestamp=none', join(contents, 'Frameworks', helper),
      ])
    }
    command('/usr/bin/codesign', [
      '--force', '--sign', '-', '--timestamp=none', join(contents, 'MacOS', 'libsteam_api.dylib'),
    ])
    command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', appPath])
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    steps.push({ id: 'codesign', status: 'pass', detail: 'Ad-hoc bundle signature verified' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new NativeOperationError('BUILD_FAILED', detail, [
      ...steps,
      { id: 'codesign', status: 'fail', detail },
    ])
  }

  return {
    steps,
    appPath,
    executablePath,
    steamworksSdkRoot,
    artifacts: [
      { kind: 'bundle', path: appPath, target, sha256: hashTree(appPath) },
      { kind: 'binary', path: executablePath, target, sha256: hashTree(executablePath) },
    ],
  }
}

const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

const count = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

export function parseRuntimeReport(value: unknown): RuntimeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Runtime report must be an object')
  }
  const report = value as Record<string, unknown>
  if (report.schemaVersion !== 1) throw new Error('Unsupported runtime report schemaVersion')
  if (report.renderer !== 'metal') throw new Error('Runtime report renderer must be metal')
  return {
    schemaVersion: 1,
    renderer: 'metal',
    steamAvailable: boolean(report.steamAvailable, 'steamAvailable'),
    pageLoaded: boolean(report.pageLoaded, 'pageLoaded'),
    loadFailed: boolean(report.loadFailed, 'loadFailed'),
    acceleratedCallbacks: count(report.acceleratedCallbacks, 'acceleratedCallbacks'),
    presentedFrames: count(report.presentedFrames, 'presentedFrames'),
    presentFailures: count(report.presentFailures, 'presentFailures'),
    cpuPaintFrames: count(report.cpuPaintFrames, 'cpuPaintFrames'),
  }
}

export function validateRuntimeReport(report: RuntimeReport, allowNoSteam: boolean): string[] {
  const failures: string[] = []
  if (!report.pageLoaded || report.loadFailed) failures.push('The local game entry did not load successfully')
  if (report.acceleratedCallbacks === 0) failures.push('CEF produced no accelerated paint callbacks')
  if (report.presentedFrames === 0) failures.push('Metal presented no frames')
  if (report.presentedFrames !== report.acceleratedCallbacks) {
    failures.push('Not every accelerated CEF frame reached the Metal drawable')
  }
  if (report.presentFailures !== 0) failures.push('Metal frame presentation failures were recorded')
  if (report.cpuPaintFrames !== 0) failures.push('Forbidden CPU OnPaint fallback was used')
  if (!allowNoSteam && !report.steamAvailable) failures.push('SteamAPI_Init did not connect to Steam')
  return failures
}

export function smokeNativeMac(options: NativeSmokeOptions): {
  steps: AgentStep[]
  artifacts: AgentArtifact[]
  report: RuntimeReport
} {
  const { loaded, target } = options
  if (!targetMatchesHost(target)) {
    throw new NativeOperationError('RUNNER_REQUIRED', `${target} does not match this host`, [])
  }
  if (target === 'windows-x64') {
    throw new NativeOperationError('NATIVE_RUNTIME_PENDING', 'The Windows D3D11 host is not implemented yet', [])
  }
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 120) {
    throw new NativeOperationError('PREREQUISITE_FAILED', '--seconds must be between 1 and 120', [])
  }

  const appPath = resolve(options.bundlePath ?? join(
    loaded.projectDir,
    'build',
    `three-steam-${target}`,
    'Release',
    'three-steam-host.app',
  ))
  const executablePath = join(appPath, 'Contents', 'MacOS', 'three-steam-host')
  if (!existsSync(executablePath)) {
    throw new NativeOperationError('PREREQUISITE_FAILED', `Native bundle is missing: ${appPath}`, [
      { id: 'bundle', status: 'fail', detail: appPath },
    ])
  }

  const outputDir = resolve(options.outputDir ?? join(loaded.projectDir, 'artifacts', target))
  mkdirSync(outputDir, { recursive: true })
  const runtimeReportPath = join(outputDir, 'native-runtime.json')
  const runtimeLogPath = join(outputDir, 'native-runtime.log')
  const appIdPath = join(outputDir, 'steam_appid.txt')
  writeFileSync(appIdPath, `${loaded.config.appId}\n`)
  rmSync(runtimeReportPath, { force: true })

  const environment = {
    ...process.env,
    THREE_STEAM_RUNTIME_REPORT: runtimeReportPath,
    THREE_STEAM_SMOKE_SECONDS: String(options.seconds),
    ...(options.allowNoSteam ? { THREE_STEAM_ALLOW_NO_STEAM: '1' } : {}),
  }
  const run = spawnSync(executablePath, [], {
    cwd: outputDir,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  writeFileSync(runtimeLogPath, `${run.stdout ?? ''}${run.stderr ?? ''}`)
  rmSync(appIdPath, { force: true })

  const artifacts: AgentArtifact[] = [
    { kind: 'log', path: runtimeLogPath, target, sha256: hashTree(runtimeLogPath) },
  ]
  if (run.error || run.status !== 0 || !existsSync(runtimeReportPath)) {
    const detail = run.error?.message ?? `Native smoke exited ${run.status ?? 'without a status'}`
    throw new NativeOperationError('RUNTIME_VALIDATION_FAILED', detail, [
      { id: 'launch', status: 'fail', detail },
    ], artifacts)
  }

  let report: RuntimeReport
  try {
    report = parseRuntimeReport(JSON.parse(readFileSync(runtimeReportPath, 'utf8')) as unknown)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new NativeOperationError('RUNTIME_VALIDATION_FAILED', detail, [
      { id: 'runtime-report', status: 'fail', detail },
    ], artifacts)
  }
  artifacts.push({ kind: 'report', path: runtimeReportPath, target, sha256: hashTree(runtimeReportPath) })
  const failures = validateRuntimeReport(report, options.allowNoSteam)
  if (failures.length > 0) {
    throw new NativeOperationError('RUNTIME_VALIDATION_FAILED', failures.join('; '), [
      { id: 'runtime-report', status: 'fail', detail: failures.join('; ') },
    ], artifacts)
  }

  return {
    report,
    artifacts,
    steps: [
      { id: 'launch', status: 'pass', detail: `${options.seconds}s native process smoke` },
      { id: 'local-entry', status: 'pass', detail: loaded.entryPath },
      {
        id: 'accelerated-paint',
        status: 'pass',
        detail: `${report.presentedFrames}/${report.acceleratedCallbacks} IOSurface frames presented by Metal`,
      },
      { id: 'cpu-paint', status: 'pass', detail: '0 CPU OnPaint callbacks' },
      {
        id: 'steam',
        status: report.steamAvailable ? 'pass' : 'warn',
        detail: report.steamAvailable ? 'SteamAPI_Init connected' : 'Steam unavailable; allowed only for local smoke',
      },
    ],
  }
}
