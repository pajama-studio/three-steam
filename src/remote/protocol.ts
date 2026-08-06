import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'

export const REMOTE_PROTOCOL_VERSION = 1 as const
export const DEFAULT_RUNNER_PORT = 47_731
export const DEFAULT_DISCOVERY_PORT = 47_732
export const DISCOVERY_PROBE = 'THREE_STEAM_DISCOVER_V1'
export const MAX_REMOTE_BODY_BYTES = 256 * 1024

export interface EncryptedEnvelope {
  iv: string
  ciphertext: string
  tag: string
}

export interface RunnerIdentity {
  schemaVersion: typeof REMOTE_PROTOCOL_VERSION
  service: 'three-steam-runner'
  runnerId: string
  hostname: string
  platform: NodeJS.Platform
  arch: string
  target: 'windows-x64' | 'macos-arm64' | 'macos-x64' | 'unsupported'
  port: number
  publicKey: string
  pairable: boolean
}

export interface PairRequest {
  schemaVersion: typeof REMOTE_PROTOCOL_VERSION
  controllerId: string
  controllerName: string
  controllerPublicKey: string
  payload: EncryptedEnvelope
}

export interface PairResponse {
  schemaVersion: typeof REMOTE_PROTOCOL_VERSION
  runnerId: string
  payload: EncryptedEnvelope
}

export interface RunnerCredential {
  schemaVersion: typeof REMOTE_PROTOCOL_VERSION
  runnerId: string
  hostname: string
  host: string
  port: number
  controllerId: string
  token: string
  createdAt: string
}

export interface RequestAuthHeaders {
  controllerId: string
  timestamp: string
  nonce: string
  signature: string
}

export interface EphemeralIdentity {
  privateKey: KeyObject
  publicKey: string
}

const exportPublicKey = (key: KeyObject): string =>
  key.export({ format: 'der', type: 'spki' }).toString('base64')

const importPublicKey = (value: string): KeyObject => createPublicKey({
  key: Buffer.from(value, 'base64'),
  format: 'der',
  type: 'spki',
})

export function createEphemeralIdentity(): EphemeralIdentity {
  const pair = generateKeyPairSync('x25519')
  return { privateKey: pair.privateKey, publicKey: exportPublicKey(pair.publicKey) }
}

export function derivePairingKey(
  privateKey: KeyObject,
  peerPublicKey: string,
  runnerId: string,
): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: importPublicKey(peerPublicKey) })
  return Buffer.from(hkdfSync(
    'sha256',
    shared,
    Buffer.from(runnerId, 'utf8'),
    Buffer.from('three-steam-pair-v1', 'utf8'),
    32,
  ))
}

export function encryptJson(key: Buffer, value: unknown, additionalData: string): EncryptedEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(additionalData, 'utf8'))
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptJson(key: Buffer, envelope: EncryptedEnvelope, additionalData: string): unknown {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(Buffer.from(additionalData, 'utf8'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as unknown
}

const bodyDigest = (body: string): string => createHash('sha256').update(body).digest('hex')

const authMessage = (
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string => `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyDigest(body)}`

export function signRemoteRequest(
  token: string,
  controllerId: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): RequestAuthHeaders {
  const timestamp = String(now)
  const nonce = randomBytes(16).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(token, 'base64'))
    .update(authMessage(method, path, timestamp, nonce, body))
    .digest('base64')
  return { controllerId, timestamp, nonce, signature }
}

export function verifyRemoteRequest(
  token: Buffer,
  method: string,
  path: string,
  body: string,
  headers: RequestAuthHeaders,
  now = Date.now(),
): boolean {
  const timestamp = Number(headers.timestamp)
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 30_000) return false
  const expected = createHmac('sha256', token)
    .update(authMessage(method, path, headers.timestamp, headers.nonce, body))
    .digest()
  const supplied = Buffer.from(headers.signature, 'base64')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function createRunnerId(hostname: string, publicKey: string): string {
  return createHash('sha256').update(`${hostname}\0${publicKey}`).digest('hex').slice(0, 20)
}

export function targetForHost(platform: NodeJS.Platform, arch: string): RunnerIdentity['target'] {
  if (platform === 'win32' && arch === 'x64') return 'windows-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'macos-x64'
  return 'unsupported'
}
