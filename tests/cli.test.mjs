import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const cli = resolve('dist/cli/main.js')

const invokeJson = (args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }))

test('capabilities emits one stable JSON result', () => {
  const output = invokeJson(['capabilities', '--json'])
  assert.equal(output.schemaVersion, 1)
  assert.equal(output.command, 'capabilities')
  assert.equal(output.ok, true)
  assert.equal(output.code, 'OK')
  assert.deepEqual(output.artifacts, [])
})

test('doctor writes a parseable report without polluting JSON stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'three-steam-report-'))
  const report = join(root, 'doctor.json')
  const output = invokeJson([
    'doctor',
    '--config', resolve('three-steam.config.example.json'),
    '--json',
    '--report', report,
  ])
  assert.equal(output.ok, true)
  assert.equal(output.report, report)
  assert.equal(existsSync(report), true)
  const persisted = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(persisted.schemaVersion, 1)
  assert.equal(persisted.command, 'doctor')
  assert.equal('report' in persisted, false)
})

test('pipeline routes release work to a matching native runner', () => {
  const oppositeTarget = process.platform === 'win32' ? 'macos-arm64' : 'windows-x64'
  const run = spawnSync(process.execPath, [
    cli,
    'pipeline',
    '--config', resolve('three-steam.config.example.json'),
    '--target', oppositeTarget,
    '--json',
  ], { encoding: 'utf8' })
  assert.equal(run.status, 4)
  assert.equal(run.stderr, '')
  const output = JSON.parse(run.stdout)
  assert.equal(output.ok, false)
  assert.equal(output.code, 'RUNNER_REQUIRED')
  assert.match(output.nextActions[0], /Dispatch/)
})
