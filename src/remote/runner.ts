import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { hostname as getHostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_RUNNER_PORT,
  DISCOVERY_PROBE,
  MAX_REMOTE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  createEphemeralIdentity,
  createRunnerId,
  decryptJson,
  derivePairingKey,
  encryptJson,
  targetForHost,
  verifyRemoteRequest,
  type PairRequest,
  type PairResponse,
  type RequestAuthHeaders,
  type RunnerIdentity,
} from './protocol.js'

const ALLOWED_COMMANDS = new Set(['capabilities', 'doctor', 'plan', 'build', 'smoke', 'pipeline'])
const VALUE_FLAGS = new Set([
  '--config', '--target', '--seconds', '--bundle', '--build-dir', '--output-dir',
  '--cef-root', '--steamworks-sdk',
])
const BOOLEAN_FLAGS = new Set(['--allow-no-steam'])
const PATH_FLAGS = new Set([
  '--config', '--bundle', '--build-dir', '--output-dir', '--cef-root', '--steamworks-sdk',
])

export interface RunnerOptions {
  workspace: string
  listen?: string
  port?: number
  discoveryPort?: number
  pairCode?: string
  enableDiscovery?: boolean
  commandTimeoutMs?: number
}

export interface RunnerHandle {
  identity: RunnerIdentity
  pairCode: string
  workspace: string
  close(): Promise<void>
}

interface RemoteRunRequest {
  command: string
  args: string[]
}

interface RemoteRunResponse {
  schemaVersion: 1
  ok: boolean
  command: string
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  result: unknown
}

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REMOTE_BODY_BYTES) throw new Error('Remote request body exceeds 256 KiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const parseObject = (body: string): Record<string, unknown> => {
  const value = JSON.parse(body) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

const isInside = (root: string, candidate: string): boolean => {
  const path = resolve(root, candidate)
  const lexical = relative(root, path)
  if (lexical !== '' && (lexical.startsWith('..') || isAbsolute(lexical))) return false
  let existing = path
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return false
    existing = parent
  }
  const realRoot = realpathSync(root)
  const realExisting = realpathSync(existing)
  const physical = relative(realRoot, realExisting)
  return physical === '' || (!physical.startsWith('..') && !isAbsolute(physical))
}

export function validateRemoteCommand(workspace: string, value: unknown): RemoteRunRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Remote run request must be an object')
  }
  const request = value as Record<string, unknown>
  if (typeof request.command !== 'string' || !ALLOWED_COMMANDS.has(request.command)) {
    throw new Error('Remote command is not allow-listed')
  }
  if (!Array.isArray(request.args) || request.args.some((item) => typeof item !== 'string')) {
    throw new Error('Remote command args must be an array of strings')
  }
  const args = request.args as string[]
  if (args.length > 64 || args.some((item) => item.length > 4096)) {
    throw new Error('Remote command args exceed the allowed size')
  }
  const sanitized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === undefined) throw new Error('Invalid remote argument')
    if (BOOLEAN_FLAGS.has(flag)) {
      sanitized.push(flag)
      continue
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Remote flag is not allow-listed: ${flag}`)
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (PATH_FLAGS.has(flag) && !isInside(workspace, next)) {
      throw new Error(`${flag} must resolve inside the runner workspace`)
    }
    sanitized.push(flag, next)
    index += 1
  }
  return { command: request.command, args: sanitized }
}

const gitValue = (workspace: string, args: string[]): string => {
  const run = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : ''
}

export function workspaceStatus(workspace: string): Record<string, unknown> {
  const revision = gitValue(workspace, ['rev-parse', 'HEAD'])
  const branch = gitValue(workspace, ['branch', '--show-current'])
  const porcelain = gitValue(workspace, ['status', '--porcelain=v1', '--untracked-files=normal'])
  return {
    workspace,
    revision,
    branch,
    dirty: porcelain.length > 0,
    changedFiles: porcelain ? porcelain.split('\n').length : 0,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    target: targetForHost(process.platform, process.arch),
  }
}

const executeRemoteCommand = async (
  workspace: string,
  request: RemoteRunRequest,
  timeoutMs: number,
): Promise<RemoteRunResponse> => {
  const cli = join(workspace, 'dist', 'cli', 'main.js')
  if (!existsSync(cli)) throw new Error(`Built CLI is missing: ${cli}`)
  const reportDir = join(workspace, 'artifacts', 'remote-runner')
  mkdirSync(reportDir, { recursive: true })
  const report = join(reportDir, `${Date.now()}-${request.command}.json`)
  const args = [cli, request.command, ...request.args, '--json', '--report', report]
  const started = Date.now()

  return await new Promise<RemoteRunResponse>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: process.env,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes <= 8 * 1024 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes <= 8 * 1024 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`Remote command exceeded ${timeoutMs} ms`))
        return
      }
      if (outputBytes > 8 * 1024 * 1024) {
        reject(new Error('Remote command output exceeded 8 MiB'))
        return
      }
      let parsed: unknown = null
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) as unknown : null
      } catch {
        // Keep raw stdout in the response so the controller can diagnose it.
      }
      resolvePromise({
        schemaVersion: 1,
        ok: exitCode === 0,
        command: request.command,
        exitCode,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        result: parsed,
      })
    })
  })
}

const requestHeaders = (request: IncomingMessage): RequestAuthHeaders | null => {
  const controllerId = request.headers['x-three-steam-controller']
  const timestamp = request.headers['x-three-steam-time']
  const nonce = request.headers['x-three-steam-nonce']
  const signature = request.headers['x-three-steam-signature']
  if (
    typeof controllerId !== 'string' || typeof timestamp !== 'string' ||
    typeof nonce !== 'string' || typeof signature !== 'string'
  ) return null
  return { controllerId, timestamp, nonce, signature }
}

export async function startRunner(options: RunnerOptions): Promise<RunnerHandle> {
  const workspace = realpathSync(resolve(options.workspace))
  if (!existsSync(join(workspace, 'package.json'))) throw new Error('Runner workspace has no package.json')
  if (!existsSync(join(workspace, 'dist', 'cli', 'main.js'))) {
    throw new Error('Runner workspace is not built; run npm ci && npm run build first')
  }

  const listen = options.listen ?? '127.0.0.1'
  const requestedPort = options.port ?? DEFAULT_RUNNER_PORT
  const discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT
  const pairCode = options.pairCode ?? String(100_000 + Math.floor(Math.random() * 900_000))
  if (!/^\d{6}$/.test(pairCode)) throw new Error('Pair code must be exactly six digits')
  const ephemeral = createEphemeralIdentity()
  const host = getHostname()
  const runnerId = createRunnerId(host, ephemeral.publicKey)
  const tokens = new Map<string, Buffer>()
  const usedNonces = new Map<string, number>()
  let pairAttempts = 0
  let busy = false
  let identity: RunnerIdentity | undefined

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://runner.local').pathname
      if (request.method === 'GET' && path === '/v1/health') {
        if (!identity) throw new Error('Runner is still starting')
        sendJson(response, 200, identity)
        return
      }
      const body = await readBody(request)
      if (request.method === 'POST' && path === '/v1/pair') {
        if (!identity?.pairable || Date.now() - serverStart > 10 * 60_000 || pairAttempts >= 5) {
          if (identity) identity.pairable = false
          sendJson(response, 403, { ok: false, error: 'Pairing window is closed' })
          return
        }
        pairAttempts += 1
        const requestValue = parseObject(body) as unknown as PairRequest
        if (
          requestValue.schemaVersion !== REMOTE_PROTOCOL_VERSION ||
          typeof requestValue.controllerId !== 'string' ||
          typeof requestValue.controllerName !== 'string' ||
          typeof requestValue.controllerPublicKey !== 'string'
        ) throw new Error('Invalid pairing request')
        const key = derivePairingKey(ephemeral.privateKey, requestValue.controllerPublicKey, runnerId)
        const clear = decryptJson(key, requestValue.payload, `${runnerId}:request`)
        if (typeof clear !== 'object' || clear === null || (clear as { code?: unknown }).code !== pairCode) {
          sendJson(response, 401, { ok: false, error: 'Pair code is incorrect' })
          return
        }
        const token = randomBytes(32)
        tokens.set(requestValue.controllerId, token)
        const payload = encryptJson(key, {
          token: token.toString('base64'),
          runnerId,
          hostname: host,
        }, `${runnerId}:response`)
        const pairResponse: PairResponse = {
          schemaVersion: REMOTE_PROTOCOL_VERSION,
          runnerId,
          payload,
        }
        if (!identity) throw new Error('Runner is still starting')
        identity.pairable = false
        sendJson(response, 200, pairResponse)
        return
      }

      const headers = requestHeaders(request)
      const token = headers ? tokens.get(headers.controllerId) : undefined
      if (!headers || !token || !verifyRemoteRequest(token, request.method ?? '', path, body, headers)) {
        sendJson(response, 401, { ok: false, error: 'Remote request authentication failed' })
        return
      }
      const nonceKey = `${headers.controllerId}:${headers.nonce}`
      if (usedNonces.has(nonceKey)) {
        sendJson(response, 409, { ok: false, error: 'Remote request nonce was already used' })
        return
      }
      usedNonces.set(nonceKey, Date.now())
      for (const [nonce, timestamp] of usedNonces) {
        if (Date.now() - timestamp > 60_000) usedNonces.delete(nonce)
      }

      if (request.method === 'POST' && path === '/v1/status') {
        if (!identity) throw new Error('Runner is still starting')
        sendJson(response, 200, { schemaVersion: 1, ok: true, runner: identity, workspace: workspaceStatus(workspace) })
        return
      }
      if (request.method === 'POST' && path === '/v1/run') {
        if (busy) {
          sendJson(response, 409, { ok: false, error: 'Runner already has an active command' })
          return
        }
        const remoteCommand = validateRemoteCommand(workspace, parseObject(body))
        busy = true
        try {
          const run = await executeRemoteCommand(
            workspace,
            remoteCommand,
            options.commandTimeoutMs ?? 15 * 60_000,
          )
          sendJson(response, 200, run)
        } finally {
          busy = false
        }
        return
      }
      sendJson(response, 404, { ok: false, error: 'Unknown runner endpoint' })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  const serverStart = Date.now()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, listen, () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runner did not bind a TCP port')
  identity = {
    schemaVersion: REMOTE_PROTOCOL_VERSION,
    service: 'three-steam-runner',
    runnerId,
    hostname: host,
    platform: process.platform,
    arch: process.arch,
    target: targetForHost(process.platform, process.arch),
    port: address.port,
    publicKey: ephemeral.publicKey,
    pairable: true,
  }

  let discovery: UdpSocket | undefined
  if (options.enableDiscovery !== false && listen !== '127.0.0.1' && listen !== '::1') {
    discovery = createSocket({ type: 'udp4', reuseAddr: true })
    discovery.on('error', () => {
      // TCP control remains available when UDP discovery is blocked by a firewall.
      discovery?.close()
      discovery = undefined
    })
    discovery.on('message', (message, remote) => {
      if (message.toString('utf8') !== DISCOVERY_PROBE) return
      const response = Buffer.from(JSON.stringify(identity), 'utf8')
      discovery?.send(response, remote.port, remote.address)
    })
    await new Promise<void>((resolvePromise) => {
      discovery?.once('listening', resolvePromise)
      discovery?.once('error', resolvePromise)
      discovery?.bind(discoveryPort)
    })
  }

  return {
    identity,
    pairCode,
    workspace,
    close: async () => {
      discovery?.close()
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise())
      })
    },
  }
}
