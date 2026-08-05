import { BrowserFallback, type FallbackStorage } from './browser-fallback.js'
import {
  THREE_STEAM_PROTOCOL_VERSION,
  ThreeSteamError,
  assertSafeName,
  assertSaveSize,
  encodeRequest,
  parseResponse,
  type BridgeEvent,
  type EventMap,
  type EventName,
  type HostInfo,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type SteamUser,
  type WindowState,
} from './protocol.js'
import { detectNativeTransport, type BridgeTransport } from './transport.js'

export interface ThreeSteamOptions {
  transport?: BridgeTransport | null
  fallbackStorage?: FallbackStorage
  timeoutMs?: number
}

export interface ThreeSteamClient {
  readonly isNative: boolean
  readonly host: {
    info(): Promise<HostInfo>
    ready(build: string): Promise<void>
    quit(): Promise<void>
  }
  readonly window: {
    getState(): Promise<WindowState>
    setFullscreen(fullscreen: boolean): Promise<WindowState>
    setSize(width: number, height: number): Promise<WindowState>
  }
  readonly steam: {
    user(): Promise<SteamUser>
    overlay: { open(page: MethodParams<'steam.overlay.open'>['page']): Promise<void> }
    achievements: {
      get(id: string): Promise<boolean>
      unlock(id: string): Promise<boolean>
    }
    stats: {
      get(id: string): Promise<number>
      set(id: string, value: number): Promise<boolean>
      store(): Promise<void>
    }
    presence: {
      set(key: string, value: string): Promise<boolean>
      clear(): Promise<boolean>
    }
  }
  readonly cloud: {
    read(name: string): Promise<string | null>
    write(name: string, value: string): Promise<number>
    delete(name: string): Promise<boolean>
    list(): Promise<MethodResult<'cloud.list'>['files']>
  }
  on<N extends EventName>(event: N, listener: (data: EventMap[N]) => void): () => void
}

class Client implements ThreeSteamClient {
  readonly #transport: BridgeTransport | null
  readonly #fallback: BrowserFallback
  readonly #timeoutMs: number
  readonly #listeners = new Map<EventName, Set<(data: never) => void>>()
  #nextRequest = 1

  readonly host = {
    info: (): Promise<HostInfo> => this.#invoke('host.info', {}),
    ready: async (build: string): Promise<void> => {
      if (!build.trim()) throw new ThreeSteamError('BAD_REQUEST', 'Build identifier is required')
      await this.#invoke('host.ready', { build })
    },
    quit: async (): Promise<void> => { await this.#invoke('host.quit', {}) },
  }

  readonly window = {
    getState: (): Promise<WindowState> => this.#invoke('window.getState', {}),
    setFullscreen: (fullscreen: boolean): Promise<WindowState> =>
      this.#invoke('window.setFullscreen', { fullscreen }),
    setSize: (width: number, height: number): Promise<WindowState> => {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 180) {
        throw new ThreeSteamError('BAD_REQUEST', 'Window size must be integer pixels of at least 320×180')
      }
      return this.#invoke('window.setSize', { width, height })
    },
  }

  readonly steam = {
    user: (): Promise<SteamUser> => this.#invoke('steam.user.get', {}),
    overlay: {
      open: async (page: MethodParams<'steam.overlay.open'>['page']): Promise<void> => {
        await this.#invoke('steam.overlay.open', { page })
      },
    },
    achievements: {
      get: async (id: string): Promise<boolean> => {
        assertSafeName(id, 'Achievement id')
        return (await this.#invoke('steam.achievement.get', { id })).unlocked
      },
      unlock: async (id: string): Promise<boolean> => {
        assertSafeName(id, 'Achievement id')
        return (await this.#invoke('steam.achievement.unlock', { id })).changed
      },
    },
    stats: {
      get: async (id: string): Promise<number> => {
        assertSafeName(id, 'Stat id')
        return (await this.#invoke('steam.stats.get', { id })).value
      },
      set: async (id: string, value: number): Promise<boolean> => {
        assertSafeName(id, 'Stat id')
        if (!Number.isFinite(value)) throw new ThreeSteamError('BAD_REQUEST', 'Stat value must be finite')
        return (await this.#invoke('steam.stats.set', { id, value })).changed
      },
      store: async (): Promise<void> => { await this.#invoke('steam.stats.store', {}) },
    },
    presence: {
      set: async (key: string, value: string): Promise<boolean> => {
        assertSafeName(key, 'Presence key')
        if (value.length > 255) throw new ThreeSteamError('BAD_REQUEST', 'Presence value exceeds 255 characters')
        return (await this.#invoke('steam.presence.set', { key, value })).changed
      },
      clear: async (): Promise<boolean> => (await this.#invoke('steam.presence.clear', {})).changed,
    },
  }

  readonly cloud = {
    read: async (name: string): Promise<string | null> => {
      assertSafeName(name, 'Cloud save name')
      return (await this.#invoke('cloud.read', { name })).value
    },
    write: async (name: string, value: string): Promise<number> => {
      assertSafeName(name, 'Cloud save name')
      assertSaveSize(value)
      return (await this.#invoke('cloud.write', { name, value })).bytes
    },
    delete: async (name: string): Promise<boolean> => {
      assertSafeName(name, 'Cloud save name')
      return (await this.#invoke('cloud.delete', { name })).deleted
    },
    list: async (): Promise<MethodResult<'cloud.list'>['files']> =>
      (await this.#invoke('cloud.list', {})).files,
  }

  constructor(options: ThreeSteamOptions) {
    this.#transport = options.transport === undefined ? detectNativeTransport() : options.transport
    this.#fallback = new BrowserFallback(options.fallbackStorage)
    this.#timeoutMs = options.timeoutMs ?? 5000
    this.#transport?.subscribe?.((event) => this.#dispatch(event))
  }

  get isNative(): boolean { return this.#transport !== null }

  on<N extends EventName>(event: N, listener: (data: EventMap[N]) => void): () => void {
    let listeners = this.#listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(event, listeners)
    }
    const erased = listener as (data: never) => void
    listeners.add(erased)
    return () => listeners?.delete(erased)
  }

  async #invoke<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (!this.#transport) return this.#fallback.invoke(method, params)

    const id = `js-${this.#nextRequest++}`
    const payload = encodeRequest({
      v: THREE_STEAM_PROTOCOL_VERSION,
      id,
      method,
      params,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ThreeSteamError('TIMEOUT', `${method} timed out after ${this.#timeoutMs} ms`)),
        this.#timeoutMs,
      )
    })
    try {
      const encoded = await Promise.race([this.#transport.invoke(payload), timeout])
      const response = parseResponse(encoded, id)
      if (!response.ok) throw new ThreeSteamError(response.error.code, response.error.message)
      return response.result as MethodResult<M>
    } catch (error) {
      if (error instanceof ThreeSteamError) throw error
      throw new ThreeSteamError('INTERNAL', error instanceof Error ? error.message : String(error))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #dispatch(event: BridgeEvent): void {
    const listeners = this.#listeners.get(event.event)
    if (!listeners) return
    for (const listener of listeners) listener(event.data as never)
  }
}

export function createThreeSteam(options: ThreeSteamOptions = {}): ThreeSteamClient {
  return new Client(options)
}
