#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const source = resolve(valueAfter('--source') ?? '')
const here = dirname(fileURLToPath(import.meta.url))
const destination = join(here, 'dist')

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

if (!source || !existsSync(join(source, 'package.json'))) {
  fail('Pass --source /absolute/path/to/skydancer')
}

const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
if (manifest.name !== 'skydancer' || manifest.license !== 'MIT') {
  fail('The source must be the MIT-licensed Twister & Skydancer project (package name: skydancer)')
}
const built = join(source, 'dist')
if (!existsSync(join(built, 'index.html'))) {
  fail('Twister & Skydancer dist/index.html is missing; run npm run build:web in the game repository')
}

rmSync(destination, { recursive: true, force: true })
cpSync(built, destination, { recursive: true, preserveTimestamps: true })

// The browser release uses canonical CDN URLs because some portals snapshot
// HTML. A native bundle owns all three static files, so keep its boot screen
// and fonts local. Gameplay/network URLs remain untouched.
const indexPath = join(destination, 'index.html')
const index = readFileSync(indexPath, 'utf8')
  .replaceAll('https://skydancer.rand.monster/loading-art.jpg', './loading-art.jpg')
  .replaceAll('https://skydancer.rand.monster/fonts/', './fonts/')
writeFileSync(indexPath, index)

const result = {
  schemaVersion: 1,
  ok: true,
  source,
  destination,
  entry: indexPath,
}
process.stdout.write(`${JSON.stringify(result)}\n`)
