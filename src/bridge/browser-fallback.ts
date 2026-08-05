import {
  THREE_STEAM_PROTOCOL_VERSION,
  ThreeSteamError,
  assertSafeName,
  assertSaveSize,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type WindowState,
} from './protocol.js'

export interface FallbackStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

class MemoryStorage implements FallbackStorage {
  readonly #values = new Map<string, string>()

  get length(): number { return this.#values.size }
  getItem(key: string): string | null { return this.#values.get(key) ?? null }
  setItem(key: string, value: string): void { this.#values.set(key, value) }
  removeItem(key: string): void { this.#values.delete(key) }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null }
}

const cloudPrefix = 'three-steam:cloud:'

export class BrowserFallback {
  readonly #storage: FallbackStorage

  constructor(storage?: FallbackStorage) {
    this.#storage = storage ?? (
      typeof localStorage === 'undefined' ? new MemoryStorage() : localStorage
    )
  }

  async invoke<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    switch (method) {
      case 'host.info':
        return {
          runtime: 'browser',
          platform: 'browser',
          protocolVersion: THREE_STEAM_PROTOCOL_VERSION,
          hostVersion: 'browser-fallback',
          steamAvailable: false,
          renderer: 'browser',
          acceleratedPaint: false,
        } as MethodResult<M>
      case 'host.ready':
      case 'host.quit':
        return { accepted: true } as MethodResult<M>
      case 'window.getState':
        return this.#windowState() as MethodResult<M>
      case 'window.setFullscreen': {
        const fullscreen = (params as MethodParams<'window.setFullscreen'>).fullscreen
        if (typeof document !== 'undefined') {
          if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen()
          if (!fullscreen && document.fullscreenElement) await document.exitFullscreen()
        }
        return this.#windowState() as MethodResult<M>
      }
      case 'window.setSize':
        throw new ThreeSteamError('UNSUPPORTED', 'Browsers do not allow pages to set the game window size')
      case 'cloud.read': {
        const { name } = params as MethodParams<'cloud.read'>
        assertSafeName(name, 'Cloud save name')
        return { value: this.#storage.getItem(cloudPrefix + name) } as MethodResult<M>
      }
      case 'cloud.write': {
        const { name, value } = params as MethodParams<'cloud.write'>
        assertSafeName(name, 'Cloud save name')
        assertSaveSize(value)
        this.#storage.setItem(cloudPrefix + name, value)
        return { bytes: new TextEncoder().encode(value).byteLength } as MethodResult<M>
      }
      case 'cloud.delete': {
        const { name } = params as MethodParams<'cloud.delete'>
        assertSafeName(name, 'Cloud save name')
        const key = cloudPrefix + name
        const deleted = this.#storage.getItem(key) !== null
        this.#storage.removeItem(key)
        return { deleted } as MethodResult<M>
      }
      case 'cloud.list': {
        const files = []
        for (let index = 0; index < this.#storage.length; index += 1) {
          const key = this.#storage.key(index)
          if (!key?.startsWith(cloudPrefix)) continue
          const value = this.#storage.getItem(key) ?? ''
          files.push({
            name: key.slice(cloudPrefix.length),
            bytes: new TextEncoder().encode(value).byteLength,
            modifiedAt: 0,
          })
        }
        return { files } as MethodResult<M>
      }
      default:
        throw new ThreeSteamError('STEAM_UNAVAILABLE', `${method} requires the native Steam host`)
    }
  }

  #windowState(): WindowState {
    return {
      width: typeof window === 'undefined' ? 0 : window.innerWidth,
      height: typeof window === 'undefined' ? 0 : window.innerHeight,
      scaleFactor: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      fullscreen: typeof document === 'undefined' ? false : document.fullscreenElement !== null,
      focused: typeof document === 'undefined' ? true : document.hasFocus(),
    }
  }
}
