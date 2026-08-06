import assert from 'node:assert/strict'
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  createEphemeralIdentity,
  decryptJson,
  derivePairingKey,
  encryptJson,
  signRemoteRequest,
  verifyRemoteRequest,
} from '../dist/remote/protocol.js'
import {
  getRemoteStatus,
  pairRunner,
  runRemoteCommand,
} from '../dist/remote/controller.js'
import { startRunner, validateRemoteCommand } from '../dist/remote/runner.js'

test('pairing encryption and request signatures agree without sending a shared secret', () => {
  const runner = createEphemeralIdentity()
  const controller = createEphemeralIdentity()
  const runnerKey = derivePairingKey(runner.privateKey, controller.publicKey, 'runner-1')
  const controllerKey = derivePairingKey(controller.privateKey, runner.publicKey, 'runner-1')
  assert.deepEqual(runnerKey, controllerKey)

  const envelope = encryptJson(controllerKey, { code: '123456' }, 'runner-1:request')
  assert.deepEqual(decryptJson(runnerKey, envelope, 'runner-1:request'), { code: '123456' })
  assert.throws(() => decryptJson(runnerKey, envelope, 'wrong-context'))

  const token = Buffer.alloc(32, 7)
  const body = JSON.stringify({ command: 'doctor', args: [] })
  const auth = signRemoteRequest(token.toString('base64'), 'controller-1', 'POST', '/v1/run', body, 1_000)
  assert.equal(verifyRemoteRequest(token, 'POST', '/v1/run', body, auth, 1_000), true)
  assert.equal(verifyRemoteRequest(token, 'POST', '/v1/run', `${body} `, auth, 1_000), false)
  assert.equal(verifyRemoteRequest(token, 'POST', '/v1/run', body, auth, 32_000), false)
})

test('remote command validator rejects arbitrary commands and workspace escapes', () => {
  const workspace = resolve('.')
  assert.deepEqual(
    validateRemoteCommand(workspace, { command: 'doctor', args: ['--config', 'three-steam.config.example.json'] }),
    { command: 'doctor', args: ['--config', 'three-steam.config.example.json'] },
  )
  assert.throws(() => validateRemoteCommand(workspace, { command: 'shell', args: [] }), /allow-listed/)
  assert.throws(
    () => validateRemoteCommand(workspace, { command: 'doctor', args: ['--config', '../secret.json'] }),
    /inside the runner workspace/,
  )
  assert.throws(
    () => validateRemoteCommand(workspace, { command: 'doctor', args: ['--eval', 'malicious'] }),
    /flag is not allow-listed/,
  )
})

test('remote path validation rejects a symlink that escapes the workspace', { skip: process.platform === 'win32' }, () => {
  const workspace = mkdtempSync(join(tmpdir(), 'three-steam-workspace-'))
  const outside = mkdtempSync(join(tmpdir(), 'three-steam-outside-'))
  writeFileSync(join(outside, 'config.json'), '{}')
  symlinkSync(outside, join(workspace, 'external'))
  assert.throws(
    () => validateRemoteCommand(workspace, { command: 'doctor', args: ['--config', 'external/config.json'] }),
    /inside the runner workspace/,
  )
})

test('localhost runner pairs, authenticates, reports status, and runs an allow-listed command', async () => {
  const credentialDir = mkdtempSync(join(tmpdir(), 'three-steam-remote-'))
  const credentialPath = join(credentialDir, 'runner.json')
  const runner = await startRunner({
    workspace: resolve('.'),
    listen: '127.0.0.1',
    port: 0,
    pairCode: '314159',
    enableDiscovery: false,
    commandTimeoutMs: 30_000,
  })
  try {
    await assert.rejects(() => pairRunner({
      host: '127.0.0.1',
      port: runner.identity.port,
      code: '314159',
      expectedRunnerId: '00000000000000000000',
      credentialPath,
    }), /fingerprint/)
    const paired = await pairRunner({
      host: '127.0.0.1',
      port: runner.identity.port,
      code: '314159',
      expectedRunnerId: runner.identity.runnerId,
      credentialPath,
    })
    assert.equal(paired.credential.runnerId, runner.identity.runnerId)
    if (process.platform !== 'win32') assert.equal(statSync(credentialPath).mode & 0o777, 0o600)
    assert.equal(JSON.stringify({ ...paired.credential, token: undefined }).includes(paired.credential.token), false)

    const status = await getRemoteStatus(paired.credential)
    assert.equal(status.ok, true)
    assert.equal(status.workspace.revision.length > 0, true)

    const run = await runRemoteCommand(paired.credential, 'capabilities', [])
    assert.equal(run.ok, true)
    assert.equal(run.exitCode, 0)
    assert.equal(run.result.schemaVersion, 1)
    assert.equal(run.result.command, 'capabilities')
  } finally {
    await runner.close()
  }
})
