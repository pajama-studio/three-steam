# AGENTS.md

This file is the operating contract for coding agents working in `three-steam`.
It applies to the entire repository. More specific `AGENTS.md` files may extend it
for a subtree but may not weaken its safety or release requirements.

## Mission and current status

Build an open-source, target-native runtime that packages Three.js/HTML5 games for
Steam without relying on Electron's in-process GPU workaround or a system WebView's
out-of-process final presentation.

The repository is a research preview. The bridge, CLI contract, and portable C++
protocol core are implemented. The Windows D3D11 and macOS Metal hosts are not yet
release-complete. Preserve the `NATIVE_RUNTIME_PENDING` guard until the relevant
implementation passes all P0 gates in `docs/03-validation-gates.md`.

## Read before editing

For any change beyond docs or isolated tests, read:

1. `README.md`
2. `docs/02-architecture.zh-CN.md`
3. `docs/03-validation-gates.md`
4. `docs/04-agent-cli-contract.md`

For rendering, process, Overlay, or wrapper decisions, also read
`docs/01-prior-art-and-failure-analysis.zh-CN.md`.

## Repository map

- `src/bridge/` — public TypeScript API and JSON protocol validation.
- `src/cli/` — stable noninteractive CLI contract.
- `src/remote/` — authenticated, allow-listed LAN runner; never add arbitrary shell execution.
- `native/host/` — portable protocol core and native host work.
- `schemas/` — public configuration schema; keep aligned with `src/cli/config.ts`.
- `tests/` and `native/host/tests/` — TypeScript/CLI and C++ tests.
- `examples/` — small local-only smoke inputs; no remote runtime dependencies.
- `skills/three-steam-pipeline/` — agent workflow shipped with this repository.
- `docs/` — decisions, architecture, validation, and public contracts.

Do not edit generated `dist/`, `build/`, `node_modules/`, `.cache/`, or downloaded
third-party binary trees. Regenerate them from source.

## Required workflow

1. Inspect `git status` and preserve unrelated contributor changes.
2. Make the smallest coherent change. Keep platform-neutral protocol logic separate
   from Win32/D3D11 and Cocoa/Metal implementation details.
3. Add or update tests for behavior and public contract changes.
4. Run:

   ```bash
   npm ci
   npm run verify
   node dist/cli/main.js capabilities --json
   ```

5. For CLI work, run commands with both `--json` and `--report`, parse the JSON, and
   confirm reports do not contain terminal noise.
6. Before commit, run `git diff --check` and scan tracked files for secrets, absolute
   personal paths, generated binaries, and licensed SDK content.

## Agent CLI rules

- Treat the JSON result as a public API. Do not rename or reinterpret fields without
  versioning the schema and adding compatibility tests.
- Parse `schemaVersion`, `ok`, `code`, `steps`, `artifacts`, and `nextActions`. Never
  scrape human-readable logs to determine success.
- Keep stdout to exactly one JSON object in `--json` mode. Send incidental diagnostics
  to stderr and ensure they do not expose secrets.
- Stable exit codes are documented in `docs/04-agent-cli-contract.md`.
- Run `windows-x64` only on a Windows x64 runner. Run `macos-arm64` or `macos-x64`
  only on the matching macOS runner. Cross-compilation is not release validation.
- Release success requires complete absolute artifact paths, target identifiers,
  verified SHA-256 values, automated reports, and all target P0 gates.
- Never turn `RUNNER_REQUIRED`, `PREREQUISITE_FAILED`, or
  `NATIVE_RUNTIME_PENDING` into a successful result to unblock automation.

## Architecture invariants

- Initialize Steamworks before creating the first graphics device.
- The native game process must own and present the final swapchain.
- Keep CEF renderer and GPU processes isolated.
- Use CEF accelerated off-screen rendering and copy the shared resource within the
  `OnAcceleratedPaint` callback. A CEF shared handle must not outlive that callback.
- Allow at most one GPU texture copy for a new browser frame and zero CPU pixel
  readbacks in release mode.
- Select a GPU adapter that can open CEF's first shared resource before creating the
  host swapchain; do not silently cross adapters or fall back to software rendering.
- Keep the game origin local and privileged native methods allow-listed and typed.

The following are prohibited release mechanisms:

- `--in-process-gpu`
- `--single-process`
- CPU `OnPaint` fallback
- forced 60 Hz invalidation when no new browser frame exists
- exposing Node.js, unrestricted filesystem access, or arbitrary native symbol calls

## Code and compatibility standards

- TypeScript is strict ESM and must pass the current `tsconfig.json` without casts
  that bypass external input validation.
- C++ targets C++20, warnings-as-errors, RAII ownership, deterministic teardown, and
  no exceptions crossing CEF/Steam callback boundaries.
- Validate every JSON/native boundary for size, version, method, path, and payload.
- Keep `schemas/three-steam.schema.json`, TypeScript config types/defaults, CLI help,
  and docs synchronized.
- Backward-compatible protocol additions are preferred. Breaking changes require a
  protocol version bump, migration notes, and old/new-version rejection tests.
- Keep Windows and macOS behavior explicit; avoid platform conditionals leaking into
  the public game API unless the capability truly differs.

## Testing and release claims

Portable CI proves only bridge, CLI, schema, and protocol-core behavior. It does not
prove Overlay, capture, graphics transport, input, performance, or distributable
quality.

Do not claim a target is supported until its full P0 matrix passes on real hardware.
Test app ID 480 is suitable only for smoke work; Steamworks release validation needs
an owned non-480 app. Record failures as artifacts instead of hiding or retrying them
until green.

## Dependencies, licenses, and security

- Prefer pinned, checksummed dependencies and minimal runtime permissions.
- Do not commit CEF binary distributions, Valve's licensed Steamworks SDK,
  `steam_appid.txt`, credentials, tokens, signing identities, provisioning profiles,
  user data, crash dumps, or machine-specific absolute paths.
- Do not weaken CSP, origin restrictions, bridge allow-lists, or path validation for
  convenience.
- New third-party code or assets require documented origin, license, and attribution.
- Follow `SECURITY.md` for vulnerability handling; do not publish exploit details in
  a public issue before a fix is available.

## Documentation and pull requests

- Write public docs and code comments in clear English. Existing Chinese research
  documents may remain bilingual or Chinese, but update their technical facts when
  implementation changes.
- Lead pull requests with the observable outcome, affected targets, tests run, and
  remaining validation gaps.
- Never describe a scaffold, plan, compile-only result, or mocked Steam response as a
  working native package.
