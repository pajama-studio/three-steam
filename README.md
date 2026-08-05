# three-steam

An open-source native Steam runtime and typed bridge for Three.js and HTML5 games.

> **Status: research preview.** The TypeScript bridge, configuration validator,
> agent-oriented CLI contract, and portable C++ protocol core are implemented and
> tested. The CEF/D3D11 Windows host and CEF/Metal macOS host are not release-ready;
> `pipeline` intentionally returns `NATIVE_RUNTIME_PENDING`. Do not ship a game with
> this repository yet.

## Why this exists

Electron, NW.js, Tauri, and system WebViews can package a web game, but the process
that presents the game is often not the process that owns the native game window.
That mismatch is especially painful for Steam Overlay and capture. Existing
workarounds may merge Chromium's GPU process, disable DirectComposition, force
continuous invalidation, or bind Steamworks to a Node native-addon ABI.

`three-steam` takes a different route:

- A C++ host initializes Steamworks before creating any graphics device.
- The host owns the final D3D11 or Metal swapchain that Steam can hook.
- CEF remains multi-process and renders the game with accelerated off-screen rendering.
- The host copies each new CEF frame GPU-to-GPU into a host-owned texture; no CPU pixel readback.
- Game JavaScript has no Node.js or arbitrary filesystem access and uses a typed, allow-listed bridge.
- A stable JSON CLI lets agents and CI diagnose, test, package, and validate target-native builds.

The prior-art review and the technical reasoning live in
[docs/01-prior-art-and-failure-analysis.zh-CN.md](docs/01-prior-art-and-failure-analysis.zh-CN.md).

## What is implemented

| Area | Status |
|---|---|
| TypeScript Steam/host/cloud bridge | Implemented and unit-tested |
| Browser development fallback | Implemented; never fakes Steam success |
| Strict JSON project configuration | Implemented |
| Agent CLI result/exit-code contract | Implemented and unit-tested |
| Portable C++ protocol validation core | Implemented and tested with CTest |
| Windows/macOS CI for the portable core | Implemented |
| Win32 + CEF accelerated OSR + D3D11 host | Planned; P0 implementation target |
| Cocoa + CEF accelerated OSR + Metal host | Planned after Windows P0 validation |
| Steam distributable packaging | Guarded until the native hosts pass release gates |

## Repository layout

- `src/bridge` — typed browser/native API, protocol validation, and browser fallback.
- `src/cli` — noninteractive configuration, diagnostics, planning, and pipeline contract.
- `native/host` — portable C++ protocol core and future native hosts.
- `examples/basic-game` — local WebGL2 smoke bundle for CLI checks.
- `schemas` — project configuration JSON Schema.
- `skills/three-steam-pipeline` — reusable Agent workflow for build and release validation.
- `docs/02-architecture.zh-CN.md` — selected rendering architecture and lifecycle.
- `docs/03-validation-gates.md` — target-hardware release gates.
- `docs/04-agent-cli-contract.md` — stable JSON, exit-code, runner, and artifact contract.

## Develop

Requirements: Node.js 20+, npm, CMake 3.21+, and a C++20 compiler.

```bash
git clone https://github.com/pajama-studio/three-steam.git
cd three-steam
npm ci
npm run verify
node dist/cli/main.js capabilities --json
node dist/cli/main.js doctor \
  --config three-steam.config.example.json \
  --json \
  --report artifacts/local/doctor.json
```

`npm run verify` runs TypeScript build/tests and the portable C++ test suite. It
does **not** certify Steam Overlay or a native distributable.

## Agent and CI usage

Always request JSON and persist a report:

```bash
node dist/cli/main.js plan \
  --config three-steam.config.example.json \
  --target windows-x64 \
  --json \
  --report artifacts/windows-x64/plan.json

node dist/cli/main.js pipeline \
  --config three-steam.config.example.json \
  --target windows-x64 \
  --json \
  --report artifacts/windows-x64/pipeline.json
```

Windows releases must run on Windows x64. macOS releases must run on the matching
macOS architecture. An agent may claim packaging success only when the CLI returns
`ok: true`, required artifacts exist with verified SHA-256 hashes, and every target
P0 gate passes. See [AGENTS.md](AGENTS.md) and
[docs/04-agent-cli-contract.md](docs/04-agent-cli-contract.md).

## Bridge preview

The package is not published to npm yet. During repository development, import the
built bridge locally:

```ts
import { createThreeSteam } from 'three-steam'

const runtime = createThreeSteam()
await runtime.host.ready('1.0.0')
await runtime.steam.achievements.unlock('FIRST_STORM')
await runtime.cloud.write('save.json', JSON.stringify({ level: 2 }))
```

In a normal browser, local saves use browser storage and Steam-only calls reject
with `STEAM_UNAVAILABLE`; they never silently report success.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report
security issues privately as described in [SECURITY.md](SECURITY.md).

CEF binary distributions and Valve's licensed Steamworks SDK are intentionally not
stored in this repository. Contributors must provide them locally under their
respective licenses.

## License

[MIT](LICENSE) © Pajama Studio.
