# Contributing to three-steam

Thank you for helping build a reliable native runtime for web games on Steam.

## Before you start

- Read `AGENTS.md` and the architecture/validation documents it references.
- Open an issue before a large architecture change or new platform backend.
- Keep licensed Steamworks SDK files and downloaded CEF binaries outside Git.
- Do not report a platform as supported until its documented P0 gates pass.

## Local verification

```bash
npm ci
npm run verify
node dist/cli/main.js capabilities --json
node dist/cli/main.js doctor \
  --config three-steam.config.example.json \
  --json \
  --report artifacts/local/doctor.json
```

The portable suite runs on Windows and macOS. Graphics, Steam Overlay, input,
capture, and packaging changes also require target-native evidence described in
`docs/03-validation-gates.md`.

## Pull requests

Include:

- the problem and observable outcome;
- affected platforms and public contracts;
- tests and hardware matrix run;
- artifact/report paths for native validation;
- known gaps or follow-up work;
- dependency license and attribution for new third-party code.

Keep pull requests focused. Update tests, JSON Schema, CLI help, and documentation
when changing a public configuration, protocol, or result contract.

## Commit style

Use short imperative subjects with a conventional prefix where useful, for example:

```text
feat(cli): emit deterministic package manifests
fix(d3d11): reopen CEF handles inside paint callback
docs: clarify macOS validation status
```

By contributing, you agree that your contribution is licensed under the repository's
MIT License.
