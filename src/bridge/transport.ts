import { parseEvent, type BridgeEvent } from './protocol.js'

export interface BridgeTransport {
  invoke(payload: string): Promise<string>
  subscribe?(listener: (event: BridgeEvent) => void): () => void
}

interface CefQueryOptions {
  request: string
  persistent?: boolean
  onSuccess(response: string): void
  onFailure(code: number, message: string): void
}

interface InjectedTransport {
  invoke(payload: string): Promise<string>
}

declare global {
  interface Window {
    cefQuery?: (options: CefQueryOptions) => void
    __THREE_STEAM_TRANSPORT__?: InjectedTransport
    __threeSteamDispatch?: (payload: string) => void
  }
}

const eventListeners = new Set<(event: BridgeEvent) => void>()
let dispatcherInstalled = false

function installDispatcher(): void {
  if (dispatcherInstalled || typeof window === 'undefined') return
  dispatcherInstalled = true
  window.__threeSteamDispatch = (payload: string) => {
    const event = parseEvent(payload)
    if (!event) return
    for (const listener of eventListeners) listener(event)
  }
}

function subscribe(listener: (event: BridgeEvent) => void): () => void {
  installDispatcher()
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function detectNativeTransport(): BridgeTransport | null {
  if (typeof window === 'undefined') return null

  const injected = window.__THREE_STEAM_TRANSPORT__
  if (injected?.invoke) {
    return {
      invoke: (payload) => injected.invoke(payload),
      subscribe,
    }
  }

  if (typeof window.cefQuery === 'function') {
    return {
      invoke: (payload) => new Promise<string>((resolve, reject) => {
        window.cefQuery?.({
          request: payload,
          onSuccess: resolve,
          onFailure: (code, message) => reject(new Error(`CEF query ${code}: ${message}`)),
        })
      }),
      subscribe,
    }
  }

  return null
}
