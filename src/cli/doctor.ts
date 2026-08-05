import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { LoadedConfig } from './config.js'
import { targetMatchesHost, type Target } from './target.js'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: CheckStatus
  message: string
}

const commandAvailable = (command: string, args: string[]): boolean => {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

export function runDoctor(loaded: LoadedConfig, target?: Target): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  checks.push({ id: 'config', status: 'pass', message: loaded.configPath })
  checks.push({
    id: 'game-dir',
    status: existsSync(loaded.gameDir) && statSync(loaded.gameDir).isDirectory() ? 'pass' : 'fail',
    message: loaded.gameDir,
  })
  checks.push({
    id: 'entry',
    status: existsSync(loaded.entryPath) && statSync(loaded.entryPath).isFile() ? 'pass' : 'fail',
    message: loaded.entryPath,
  })
  checks.push({
    id: 'cmake',
    status: commandAvailable('cmake', ['--version']) ? 'pass' : 'fail',
    message: 'CMake 3.21+ is required to build the native host',
  })
  checks.push({
    id: 'platform',
    status: target === undefined
      ? (process.platform === 'win32' || process.platform === 'darwin' ? 'pass' : 'warn')
      : (targetMatchesHost(target) ? 'pass' : 'warn'),
    message: target === undefined
      ? `Portable checks are running on ${process.platform}-${process.arch}`
      : targetMatchesHost(target)
        ? `${target} native checks are available on this host`
        : `${target} requires a matching native runner; this host is ${process.platform}-${process.arch}`,
  })
  if (target !== undefined) {
    const backend = loaded.config.renderer.backend
    const incompatible = (target === 'windows-x64' && backend === 'metal') ||
      (target !== 'windows-x64' && backend === 'd3d11')
    checks.push({
      id: 'renderer-target',
      status: incompatible ? 'fail' : 'pass',
      message: incompatible
        ? `${backend} is incompatible with ${target}`
        : `${backend} is valid for ${target}`,
    })
  }
  checks.push({
    id: 'cef',
    status: process.env.CEF_ROOT ? 'pass' : 'warn',
    message: process.env.CEF_ROOT ?? 'Set CEF_ROOT or let the pinned build download CEF',
  })
  checks.push({
    id: 'steamworks',
    status: process.env.STEAMWORKS_SDK ? 'pass' : 'warn',
    message: process.env.STEAMWORKS_SDK ?? 'Set STEAMWORKS_SDK to your licensed SDK directory',
  })
  if (loaded.config.appId === 480) {
    checks.push({
      id: 'app-id',
      status: 'warn',
      message: '480 is acceptable for smoke tests; release validation needs an owned non-480 app',
    })
  } else {
    checks.push({ id: 'app-id', status: 'pass', message: String(loaded.config.appId) })
  }
  return checks
}

export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}
