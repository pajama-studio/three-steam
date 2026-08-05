import assert from 'node:assert/strict'
import test from 'node:test'

import { createThreeSteam, ThreeSteamError } from '../dist/bridge/index.js'

const response = (request, result) => JSON.stringify({
  v: 1,
  id: request.id,
  ok: true,
  result,
})

test('typed client round-trips requests through the native transport', async () => {
  const methods = []
  const transport = {
    async invoke(payload) {
      const request = JSON.parse(payload)
      methods.push(request.method)
      if (request.method === 'host.info') {
        return response(request, {
          runtime: 'native',
          platform: 'windows',
          protocolVersion: 1,
          hostVersion: 'test',
          steamAvailable: true,
          renderer: 'd3d11',
          acceleratedPaint: true,
        })
      }
      if (request.method === 'steam.achievement.unlock') {
        return response(request, { changed: true })
      }
      throw new Error(`Unexpected ${request.method}`)
    },
  }
  const client = createThreeSteam({ transport })
  assert.equal(client.isNative, true)
  assert.equal((await client.host.info()).renderer, 'd3d11')
  assert.equal(await client.steam.achievements.unlock('FIRST_STORM'), true)
  assert.deepEqual(methods, ['host.info', 'steam.achievement.unlock'])
})

test('browser fallback keeps cloud saves local and never fakes Steam success', async () => {
  const values = new Map()
  const storage = {
    get length() { return values.size },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
  }
  const client = createThreeSteam({ transport: null, fallbackStorage: storage })
  assert.equal(client.isNative, false)
  assert.equal(await client.cloud.write('save.json', '{"level":2}'), 11)
  assert.equal(await client.cloud.read('save.json'), '{"level":2}')
  assert.deepEqual((await client.cloud.list()).map((file) => file.name), ['save.json'])
  await assert.rejects(
    client.steam.achievements.unlock('FIRST_STORM'),
    (error) => error instanceof ThreeSteamError && error.code === 'STEAM_UNAVAILABLE',
  )
})

test('bridge rejects traversal and stale protocol responses', async () => {
  const client = createThreeSteam({
    transport: {
      invoke: async () => JSON.stringify({ v: 99, id: 'js-1', ok: true, result: {} }),
    },
  })
  await assert.rejects(client.cloud.read('../save.json'), ThreeSteamError)
  await assert.rejects(client.host.info(), ThreeSteamError)
})
