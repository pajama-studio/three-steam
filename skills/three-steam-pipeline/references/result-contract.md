# Result contract quick reference

- Schema: `schemaVersion`, `command`, `ok`, `code`, `summary`, `steps`, `artifacts`, `nextActions`.
- Exit 0 / `OK`: requested diagnostic completed. Pipeline release success additionally requires complete, hashed artifacts and all P0 gates.
- Exit 2 / `CONFIG_INVALID` or `UNKNOWN_COMMAND`: repair invocation/configuration.
- Exit 3 / `PREREQUISITE_FAILED`: repair failed prerequisite steps.
- Exit 4 / `RUNNER_REQUIRED`: dispatch unchanged inputs to the indicated native runner.
- Exit 4 / `NATIVE_RUNTIME_PENDING`: implementation is intentionally incomplete; never bypass this guard.
- Default GitHub-hosted runners: `windows-x64` on `windows-2022`; `macos-arm64` on `macos-14`; `macos-x64` on `macos-15-intel`. Real Steam/graphics gates may require dedicated hardware runners.
- Release artifacts: native binary, Steam depot bundle, SHA-256 manifest, automated test report, P0 validation report.
