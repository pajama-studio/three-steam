export const TARGETS = ['windows-x64', 'macos-arm64', 'macos-x64'] as const

export type Target = typeof TARGETS[number]

export function parseTarget(value: string | undefined): Target {
  const requested = value ?? defaultTarget()
  if (!TARGETS.includes(requested as Target)) {
    throw new Error(`Unsupported target: ${requested}`)
  }
  return requested as Target
}

export function defaultTarget(): Target {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'macos-x64'
  throw new Error(`No default target for ${process.platform}-${process.arch}; pass --target explicitly`)
}

export function targetRunner(target: Target): string {
  if (target === 'windows-x64') return 'windows-2022'
  if (target === 'macos-arm64') return 'macos-14'
  return 'macos-15-intel'
}

export function targetMatchesHost(target: Target): boolean {
  if (target === 'windows-x64') return process.platform === 'win32' && process.arch === 'x64'
  if (target === 'macos-arm64') return process.platform === 'darwin' && process.arch === 'arm64'
  return process.platform === 'darwin' && process.arch === 'x64'
}
