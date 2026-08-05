import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTarget, targetRunner } from '../dist/cli/target.js'

test('target parsing rejects unsupported platforms', () => {
  assert.equal(parseTarget('windows-x64'), 'windows-x64')
  assert.equal(parseTarget('macos-arm64'), 'macos-arm64')
  assert.equal(parseTarget('macos-x64'), 'macos-x64')
  assert.throws(() => parseTarget('linux-x64'), /Unsupported target/)
})

test('targets route to architecture-correct public runners', () => {
  assert.equal(targetRunner('windows-x64'), 'windows-2022')
  assert.equal(targetRunner('macos-arm64'), 'macos-14')
  assert.equal(targetRunner('macos-x64'), 'macos-15-intel')
})
