import { createSocket } from 'node:dgram'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { hostname as getHostname, homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_RUNNER_PORT,
  DISCOVERY_PROBE,
  MAX_REMOTE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  createEphemeralIdentity,
  decryptJson,
  derivePairingKey,
  encryptJson,
  signRemoteRequest,
  type PairRequest,
  type PairResponse,
  type RunnerCredential,
  type RunnerIdentity,
} from './protocol.js'

export interface RemoteStatus {
  schemaVersion: 1
  ok: true
  runner: RunnerIdentity
  workspace: {
    workspace: string
    revision: string
    branch: string
    dirty: boolean
    changedFiles: number
    node: string
    platform: NodeJS.Platform
    arch: string
    target: RunnerIdentity['target']
  }
}

export interface RemoteRunResponse {
  schemaVersion: 1
  ok: boolean
  command: string
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  result: unknown
}

interface HttpJsonOptions {
  host: string
  port: number
  path: string
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

const parseJsonObject = (text: string): Record<string, unknown> => {
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Runner returned a non-object JSON response')
  }
  return value as Record<string, unknown>
}

const requestJson = async (options: HttpJsonOptions): Promise<Record<string, unknown>> =>
  await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const body = options.body ?? ''
    const request = httpRequest({
      host: options.host,
      port: options.port,
      path: options.path,
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(body ? {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
        } : {}),
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_REMOTE_BODY_BYTES * 40) {
          response.destroy(new Error('Runner response exceeds 10 MiB'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          const parsed = parseJsonObject(text)
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            const error = typeof parsed.error === 'string' ? parsed.error : `HTTP ${status}`
            reject(new Error(error))
            return
          }
          resolvePromise(parsed)
        } catch (error) {
          reject(error)
        }
      })
      response.on('error', reject)
    })
    request.setTimeout(options.timeoutMs ?? 10_000, () => {
      request.destroy(new Error(`Runner request timed out after ${options.timeoutMs ?? 10_000} ms`))
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })

const validIdentity = (value: Record<string, unknown>): RunnerIdentity => {
  const platforms = new Set(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'])
  const targets = new Set(['windows-x64', 'macos-arm64', 'macos-x64', 'unsupported'])
  if (
    value.schemaVersion !== REMOTE_PROTOCOL_VERSION ||
    value.service !== 'three-steam-runner' ||
    typeof value.runnerId !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.platform !== 'string' || !platforms.has(value.platform) ||
    typeof value.arch !== 'string' ||
    typeof value.target !== 'string' || !targets.has(value.target) ||
    typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535 ||
    typeof value.publicKey !== 'string' ||
    typeof value.pairable !== 'boolean'
  ) throw new Error('Runner identity is invalid or incompatible')
  return value as unknown as RunnerIdentity
}

export interface DiscoverOptions {
  durationMs?: number
  discoveryPort?: number
  destinations?: string[]
}

export async function discoverRunners(options: DiscoverOptions = {}): Promise<Array<RunnerIdentity & { host: string }>> {
  const durationMs = options.durationMs ?? 1_500
  const port = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT
  const destinations = options.destinations ?? ['255.255.255.255']
  const found = new Map<string, RunnerIdentity & { host: string }>()
  const socket = createSocket('udp4')
  socket.on('message', (message, remote) => {
    try {
      const identity = validIdentity(parseJsonObject(message.toString('utf8')))
      found.set(identity.runnerId, { ...identity, host: remote.address })
    } catch {
      // Ignore unrelated UDP traffic on the discovery response socket.
    }
  })
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('error', reject)
    socket.bind(0, '0.0.0.0', () => resolvePromise())
  })
  socket.setBroadcast(true)
  const probe = Buffer.from(DISCOVERY_PROBE, 'utf8')
  await Promise.all(destinations.map(async (destination) => await new Promise<void>((resolvePromise) => {
    socket.send(probe, port, destination, () => resolvePromise())
  })))
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, durationMs))
  socket.close()
  return [...found.values()].sort((left, right) => left.hostname.localeCompare(right.hostname))
}

export const defaultCredentialPath = (runnerId: string): string =>
  resolve(homedir(), '.three-steam', 'runners', `${runnerId}.json`)

const writeCredential = (path: string, credential: RunnerCredential): string => {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  writeFileSync(absolute, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
  chmodSync(absolute, 0o600)
  return absolute
}

export interface PairRunnerOptions {
  host: string
  port?: number
  code: string
  expectedRunnerId: string
  credentialPath?: string
}

export async function pairRunner(options: PairRunnerOptions): Promise<{ credential: RunnerCredential; path: string }> {
  if (!/^\d{6}$/.test(options.code)) throw new Error('Pair code must be exactly six digits')
  const port = options.port ?? DEFAULT_RUNNER_PORT
  const identity = validIdentity(await requestJson({ host: options.host, port, path: '/v1/health' }))
  if (!/^[a-f0-9]{20}$/.test(options.expectedRunnerId) || identity.runnerId !== options.expectedRunnerId) {
    throw new Error('Runner fingerprint does not match --runner-id; stop and verify the Windows console')
  }
  if (!identity.pairable) throw new Error('Runner pairing window is closed; restart the runner to pair again')
  const controller = createEphemeralIdentity()
  const controllerName = getHostname()
  const controllerId = createHash('sha256')
    .update(`${controllerName}\0${controller.publicKey}\0${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)
  const key = derivePairingKey(controller.privateKey, identity.publicKey, identity.runnerId)
  const pairRequest: PairRequest = {
    schemaVersion: REMOTE_PROTOCOL_VERSION,
    controllerId,
    controllerName,
    controllerPublicKey: controller.publicKey,
    payload: encryptJson(key, { code: options.code }, `${identity.runnerId}:request`),
  }
  const response = await requestJson({
    host: options.host,
    port,
    path: '/v1/pair',
    method: 'POST',
    body: JSON.stringify(pairRequest),
  }) as unknown as PairResponse
  if (response.schemaVersion !== REMOTE_PROTOCOL_VERSION || response.runnerId !== identity.runnerId) {
    throw new Error('Pair response identity does not match the requested runner')
  }
  const clear = decryptJson(key, response.payload, `${identity.runnerId}:response`)
  if (typeof clear !== 'object' || clear === null || typeof (clear as { token?: unknown }).token !== 'string') {
    throw new Error('Pair response did not contain a valid credential')
  }
  const credential: RunnerCredential = {
    schemaVersion: REMOTE_PROTOCOL_VERSION,
    runnerId: identity.runnerId,
    hostname: identity.hostname,
    host: options.host,
    port: identity.port,
    controllerId,
    token: (clear as { token: string }).token,
    createdAt: new Date().toISOString(),
  }
  const path = writeCredential(options.credentialPath ?? defaultCredentialPath(identity.runnerId), credential)
  return { credential, path }
}

export function readCredential(path: string): RunnerCredential {
  const value = parseJsonObject(readFileSync(resolve(path), 'utf8'))
  if (
    value.schemaVersion !== REMOTE_PROTOCOL_VERSION ||
    typeof value.runnerId !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.port !== 'number' ||
    typeof value.controllerId !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.createdAt !== 'string'
  ) throw new Error('Runner credential is invalid or incompatible')
  const token = Buffer.from(value.token, 'base64')
  if (token.length !== 32 || token.toString('base64') !== value.token) {
    throw new Error('Runner credential token is invalid')
  }
  return value as unknown as RunnerCredential
}

const authenticatedRequest = async (
  credential: RunnerCredential,
  path: string,
  value: unknown,
  timeoutMs?: number,
): Promise<Record<string, unknown>> => {
  const body = JSON.stringify(value)
  const auth = signRemoteRequest(
    credential.token,
    credential.controllerId,
    'POST',
    path,
    body,
  )
  const headers: Record<string, string> = {
    'x-three-steam-controller': auth.controllerId,
    'x-three-steam-time': auth.timestamp,
    'x-three-steam-nonce': auth.nonce,
    'x-three-steam-signature': auth.signature,
  }
  return await requestJson({
    host: credential.host,
    port: credential.port,
    path,
    method: 'POST',
    body,
    headers,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

export async function getRemoteStatus(credential: RunnerCredential): Promise<RemoteStatus> {
  const value = await authenticatedRequest(credential, '/v1/status', {})
  const runnerValue = value.runner
  const workspace = value.workspace
  if (
    value.schemaVersion !== REMOTE_PROTOCOL_VERSION || value.ok !== true ||
    typeof runnerValue !== 'object' || runnerValue === null || Array.isArray(runnerValue) ||
    typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)
  ) {
    throw new Error('Runner returned an invalid status response')
  }
  const runner = validIdentity(runnerValue as Record<string, unknown>)
  const status = workspace as Record<string, unknown>
  if (
    typeof status.workspace !== 'string' || typeof status.revision !== 'string' ||
    typeof status.branch !== 'string' || typeof status.dirty !== 'boolean' ||
    typeof status.changedFiles !== 'number' || typeof status.node !== 'string' ||
    typeof status.platform !== 'string' || typeof status.arch !== 'string' ||
    typeof status.target !== 'string'
  ) throw new Error('Runner returned invalid workspace status')
  return { schemaVersion: 1, ok: true, runner, workspace: status as unknown as RemoteStatus['workspace'] }
}

export async function runRemoteCommand(
  credential: RunnerCredential,
  command: string,
  args: string[],
  timeoutMs = 15 * 60_000,
): Promise<RemoteRunResponse> {
  const value = await authenticatedRequest(credential, '/v1/run', { command, args }, timeoutMs)
  if (
    value.schemaVersion !== REMOTE_PROTOCOL_VERSION ||
    typeof value.ok !== 'boolean' ||
    typeof value.command !== 'string' ||
    (typeof value.exitCode !== 'number' && value.exitCode !== null) ||
    typeof value.durationMs !== 'number' ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string'
  ) throw new Error('Runner returned an invalid command response')
  return value as unknown as RemoteRunResponse
}

export function publicCredentialSummary(credential: RunnerCredential): Omit<RunnerCredential, 'token'> {
  const { token: _token, ...publicFields } = credential
  return publicFields
}
