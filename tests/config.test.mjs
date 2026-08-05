import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { defaultConfig, loadConfig, parseConfig } from '../dist/cli/config.js'
import { doctorExitCode, runDoctor } from '../dist/cli/doctor.js'

test('default config is strict and resolves the packaged entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'three-steam-'))
  const game = join(root, 'dist')
  mkdirSync(game)
  writeFileSync(join(game, 'index.html'), '<canvas></canvas>')
  writeFileSync(join(root, 'three-steam.config.json'), JSON.stringify(defaultConfig()))
  const loaded = loadConfig(join(root, 'three-steam.config.json'))
  assert.equal(loaded.entryPath, join(game, 'index.html'))
  const checks = runDoctor(loaded)
  assert.equal(doctorExitCode(checks), 0)
  assert.equal(checks.find((check) => check.id === 'entry')?.status, 'pass')
})

test('config forbids CPU rendering and remote entry paths', () => {
  assert.throws(
    () => parseConfig({ ...defaultConfig(), renderer: { requireHardwareAcceleration: false } }),
    /CPU paint fallback is forbidden/,
  )
  assert.throws(
    () => parseConfig({ ...defaultConfig(), entry: '../index.html' }),
    /single local/,
  )
})
