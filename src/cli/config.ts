import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'

export interface ThreeSteamConfig {
  appId: number
  name: string
  title: string
  gameDir: string
  entry: string
  window: {
    width: number
    height: number
    fullscreen: boolean
    resizable: boolean
  }
  renderer: {
    backend: 'auto' | 'd3d11' | 'metal'
    frameRate: number
    requireHardwareAcceleration: true
  }
  security: {
    allowRemoteOrigins: string[]
  }
}

export interface LoadedConfig {
  config: ThreeSteamConfig
  configPath: string
  projectDir: string
  gameDir: string
  entryPath: string
}

export function defaultConfig(): ThreeSteamConfig {
  return {
    appId: 480,
    name: 'my-three-game',
    title: 'My Three Game',
    gameDir: './dist',
    entry: 'index.html',
    window: {
      width: 1280,
      height: 720,
      fullscreen: false,
      resizable: true,
    },
    renderer: {
      backend: 'auto',
      frameRate: 60,
      requireHardwareAcceleration: true,
    },
    security: { allowRemoteOrigins: [] },
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Configuration root must be a JSON object')
  }
  return value as Record<string, unknown>
}

const integer = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || Number(resolved) < min || Number(resolved) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return Number(resolved)
}

const boolean = (value: unknown, fallback: boolean, label: string): boolean => {
  const resolved = value ?? fallback
  if (typeof resolved !== 'boolean') throw new Error(`${label} must be boolean`)
  return resolved
}

export function parseConfig(value: unknown): ThreeSteamConfig {
  const root = object(value)
  const windowConfig = root.window === undefined ? {} : object(root.window)
  const renderer = root.renderer === undefined ? {} : object(root.renderer)
  const security = root.security === undefined ? {} : object(root.security)

  const appId = integer(root.appId, 0, 1, 2_147_483_647, 'appId')
  if (typeof root.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(root.name)) {
    throw new Error('name must contain 2-63 lowercase letters, digits or hyphens')
  }
  if (typeof root.title !== 'string' || root.title.length < 1 || root.title.length > 128) {
    throw new Error('title must contain 1-128 characters')
  }
  if (typeof root.gameDir !== 'string' || root.gameDir.length === 0) {
    throw new Error('gameDir is required')
  }
  if (typeof root.entry !== 'string' || !/^[^/\\]+\.html$/.test(root.entry)) {
    throw new Error('entry must be a single local .html filename')
  }
  if (
    renderer.backend !== undefined &&
    renderer.backend !== 'auto' &&
    renderer.backend !== 'd3d11' &&
    renderer.backend !== 'metal'
  ) {
    throw new Error('renderer.backend must be auto, d3d11 or metal')
  }
  if (renderer.requireHardwareAcceleration === false) {
    throw new Error('CPU paint fallback is forbidden; requireHardwareAcceleration must be true')
  }
  const origins = security.allowRemoteOrigins ?? []
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) {
    throw new Error('security.allowRemoteOrigins must be an array of URLs')
  }

  return {
    appId,
    name: root.name,
    title: root.title,
    gameDir: root.gameDir,
    entry: root.entry,
    window: {
      width: integer(windowConfig.width, 1280, 640, 16384, 'window.width'),
      height: integer(windowConfig.height, 720, 360, 16384, 'window.height'),
      fullscreen: boolean(windowConfig.fullscreen, false, 'window.fullscreen'),
      resizable: boolean(windowConfig.resizable, true, 'window.resizable'),
    },
    renderer: {
      backend: (renderer.backend ?? 'auto') as 'auto' | 'd3d11' | 'metal',
      frameRate: integer(renderer.frameRate, 60, 30, 240, 'renderer.frameRate'),
      requireHardwareAcceleration: true,
    },
    security: { allowRemoteOrigins: origins as string[] },
  }
}

export function loadConfig(configPath: string): LoadedConfig {
  const absoluteConfig = resolve(configPath)
  const projectDir = dirname(absoluteConfig)
  const config = parseConfig(JSON.parse(readFileSync(absoluteConfig, 'utf8')) as unknown)
  const gameDir = normalize(isAbsolute(config.gameDir) ? config.gameDir : join(projectDir, config.gameDir))
  return {
    config,
    configPath: absoluteConfig,
    projectDir,
    gameDir,
    entryPath: join(gameDir, config.entry),
  }
}
