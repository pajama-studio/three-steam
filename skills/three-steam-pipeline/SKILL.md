---
name: three-steam-pipeline
description: Use when an agent must diagnose, test, build, package, or validate a Three.js or HTML5 game for Steam on Windows and macOS with the three-steam CLI. Covers native runner routing, stable JSON results, artifact manifests, and Steam Overlay release gates.
---

# Three Steam Pipeline

Operate `three-steam` through its machine contract. Treat a successful release as an evidence-backed target-native result, never merely a successful compile.

## Workflow

1. Read the repository `AGENTS.md`, `docs/02-architecture.zh-CN.md`, and `docs/03-validation-gates.md`.
2. Install and verify the portable toolchain:

   ```bash
   npm ci
   npm run verify
   node dist/cli/main.js capabilities --json
   ```

3. Select `windows-x64`, `macos-arm64`, or `macos-x64`. Dispatch the work to the matching native runner; do not claim release coverage from cross-compilation.
4. Run `doctor` and persist its report:

   ```bash
   node dist/cli/main.js doctor --config three-steam.config.json --target windows-x64 --json --report artifacts/windows-x64/doctor.json
   ```

5. Parse stdout as one JSON object. Require `schemaVersion: 1`; branch on `ok` and stable `code`. Never scrape human text.
6. Run `plan`, then `pipeline` with the same target, configuration, and explicit report paths.
7. Declare packaging successful only if `ok` is `true`, required artifact entries exist, every distributable has a verified SHA-256, and the target's P0 validation gates pass.

## Hard constraints

- Do not bypass `NATIVE_RUNTIME_PENDING` or convert `RUNNER_REQUIRED` into success.
- Do not add `--in-process-gpu`, `--single-process`, or CPU `OnPaint` fallback.
- Do not commit CEF binaries, the licensed Steamworks SDK, `steam_appid.txt`, secrets, or user data.
- Keep Windows and macOS release reports separate. Run Steam Overlay, capture, input, resize, GPU recovery, and performance gates on real target hardware.
- Preserve the bridge protocol and JSON result schema. Version intentional breaking changes.

## Failure handling

Use `nextActions` as the first recovery path. For `PREREQUISITE_FAILED`, fix failed checks and rerun the same command. For `RUNNER_REQUIRED`, dispatch unchanged inputs to the named runner. For `NATIVE_RUNTIME_PENDING`, implement and validate the missing native runtime before removing the guard.

Read `references/result-contract.md` when integrating another agent, CI provider, or build orchestrator.
