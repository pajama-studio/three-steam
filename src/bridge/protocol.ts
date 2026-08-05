export const THREE_STEAM_PROTOCOL_VERSION = 1 as const
export const MAX_REQUEST_BYTES = 256 * 1024
export const MAX_SAVE_BYTES = 8 * 1024 * 1024

export type BridgeErrorCode =
  | 'BAD_REQUEST'
  | 'DENIED'
  | 'INTERNAL'
  | 'NOT_FOUND'
  | 'STEAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED'

export interface HostInfo {
  runtime: 'native' | 'browser'
  platform: 'windows' | 'macos' | 'linux' | 'browser'
  protocolVersion: number
  hostVersion: string
  cefVersion?: string
  steamAvailable: boolean
  renderer: 'd3d11' | 'metal' | 'vulkan' | 'browser'
  acceleratedPaint: boolean
}

export interface WindowState {
  width: number
  height: number
  scaleFactor: number
  fullscreen: boolean
  focused: boolean
}

export interface SteamUser {
  steamId: string
  name: string
  language: string
}

export interface CloudFile {
  name: string
  bytes: number
  modifiedAt: number
}

export interface MethodMap {
  'host.info': { params: Record<string, never>; result: HostInfo }
  'host.ready': { params: { build: string }; result: { accepted: true } }
  'host.quit': { params: Record<string, never>; result: { accepted: true } }
  'window.getState': { params: Record<string, never>; result: WindowState }
  'window.setFullscreen': { params: { fullscreen: boolean }; result: WindowState }
  'window.setSize': { params: { width: number; height: number }; result: WindowState }
  'steam.user.get': { params: Record<string, never>; result: SteamUser }
  'steam.overlay.open': {
    params: { page: 'achievements' | 'community' | 'friends' | 'settings' }
    result: { opened: true }
  }
  'steam.achievement.get': { params: { id: string }; result: { unlocked: boolean } }
  'steam.achievement.unlock': { params: { id: string }; result: { changed: boolean } }
  'steam.stats.get': { params: { id: string }; result: { value: number } }
  'steam.stats.set': { params: { id: string; value: number }; result: { changed: boolean } }
  'steam.stats.store': { params: Record<string, never>; result: { stored: true } }
  'steam.presence.set': { params: { key: string; value: string }; result: { changed: boolean } }
  'steam.presence.clear': { params: Record<string, never>; result: { changed: boolean } }
  'cloud.read': { params: { name: string }; result: { value: string | null } }
  'cloud.write': { params: { name: string; value: string }; result: { bytes: number } }
  'cloud.delete': { params: { name: string }; result: { deleted: boolean } }
  'cloud.list': { params: Record<string, never>; result: { files: CloudFile[] } }
}

export type MethodName = keyof MethodMap
export type MethodParams<M extends MethodName> = MethodMap[M]['params']
export type MethodResult<M extends MethodName> = MethodMap[M]['result']

export interface EventMap {
  'overlay.changed': { active: boolean }
  'window.focus': Record<string, never>
  'window.blur': Record<string, never>
  'window.resized': WindowState
  'display.changed': WindowState
  'device.lost': { reason: string }
  'lifecycle.suspend': Record<string, never>
  'lifecycle.resume': Record<string, never>
}

export type EventName = keyof EventMap

export interface BridgeRequest<M extends MethodName = MethodName> {
  v: typeof THREE_STEAM_PROTOCOL_VERSION
  id: string
  method: M
  params: MethodParams<M>
}

export type BridgeResponse =
  | {
      v: typeof THREE_STEAM_PROTOCOL_VERSION
      id: string
      ok: true
      result: unknown
    }
  | {
      v: typeof THREE_STEAM_PROTOCOL_VERSION
      id: string
      ok: false
      error: { code: BridgeErrorCode; message: string }
    }

export interface BridgeEvent<N extends EventName = EventName> {
  v: typeof THREE_STEAM_PROTOCOL_VERSION
  event: N
  data: EventMap[N]
}

const encoder = new TextEncoder()
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function encodeRequest<M extends MethodName>(request: BridgeRequest<M>): string {
  const encoded = JSON.stringify(request)
  if (encoder.encode(encoded).byteLength > MAX_REQUEST_BYTES) {
    throw new ThreeSteamError('BAD_REQUEST', 'Native request exceeds the 256 KiB limit')
  }
  return encoded
}

export function parseResponse(encoded: string, requestId: string): BridgeResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    throw new ThreeSteamError('INTERNAL', 'Native host returned invalid JSON')
  }
  if (!isObject(parsed) || parsed.v !== THREE_STEAM_PROTOCOL_VERSION) {
    throw new ThreeSteamError('INTERNAL', 'Native host protocol version mismatch')
  }
  if (parsed.id !== requestId || typeof parsed.ok !== 'boolean') {
    throw new ThreeSteamError('INTERNAL', 'Native host response does not match the request')
  }
  if (parsed.ok) {
    return parsed as unknown as BridgeResponse
  }
  if (!isObject(parsed.error) || typeof parsed.error.code !== 'string' || typeof parsed.error.message !== 'string') {
    throw new ThreeSteamError('INTERNAL', 'Native host returned an invalid error envelope')
  }
  return parsed as unknown as BridgeResponse
}

export function parseEvent(encoded: string): BridgeEvent | null {
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (
      !isObject(parsed) ||
      parsed.v !== THREE_STEAM_PROTOCOL_VERSION ||
      typeof parsed.event !== 'string' ||
      !isObject(parsed.data)
    ) {
      return null
    }
    return parsed as unknown as BridgeEvent
  } catch {
    return null
  }
}

export function assertSafeName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) || value.includes('..')) {
    throw new ThreeSteamError('BAD_REQUEST', `${label} contains unsafe characters`)
  }
}

export function assertSaveSize(value: string): void {
  if (encoder.encode(value).byteLength > MAX_SAVE_BYTES) {
    throw new ThreeSteamError('BAD_REQUEST', 'Cloud save exceeds the 8 MiB per-file limit')
  }
}

export class ThreeSteamError extends Error {
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'ThreeSteamError'
    this.code = code
  }
}
