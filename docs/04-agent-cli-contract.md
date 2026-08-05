# Agent CLI contract

`three-steam` treats machine-readable automation as a public API. Interactive text is for humans; agents and CI must request JSON.

## Invocation

```bash
three-steam capabilities --json
three-steam doctor --config three-steam.config.json --target windows-x64 --json --report artifacts/windows-x64/doctor.json
three-steam plan --config three-steam.config.json --target windows-x64 --json --report artifacts/windows-x64/plan.json
three-steam pipeline --config three-steam.config.json --target windows-x64 --json --report artifacts/windows-x64/pipeline.json
```

Supported targets are `windows-x64`, `macos-arm64`, and `macos-x64`. A release pipeline must run on a matching native runner.

Default public GitHub runner routing is `windows-2022`, `macos-14` (arm64), and
`macos-15-intel` (x64), respectively. Hosted CI verifies the portable core; real
Steam, GPU, Overlay, input, capture, and performance gates still require suitable
target hardware.

## Result schema

Every JSON invocation emits exactly one JSON object to stdout. Diagnostics belong on stderr; they must never corrupt stdout.

```json
{
  "schemaVersion": 1,
  "command": "pipeline",
  "ok": false,
  "code": "RUNNER_REQUIRED",
  "summary": "windows-x64 must run on windows-2022",
  "steps": [{ "id": "native-runtime", "status": "skipped", "detail": "..." }],
  "artifacts": [],
  "nextActions": ["Dispatch this command to windows-2022"],
  "report": "/absolute/path/to/report.json"
}
```

The report file contains the same stable result without the convenience `report` field. Agents must reject unknown major schema versions.

## Exit codes

| Exit | Stable code | Meaning |
|---:|---|---|
| 0 | `OK` | The requested diagnostic or operation completed. For `pipeline`, this will only mean release artifacts and gates passed. |
| 2 | `CONFIG_INVALID`, `UNKNOWN_COMMAND` | The invocation or configuration is invalid. |
| 3 | `PREREQUISITE_FAILED` | A required tool, file, SDK, or configuration is unavailable. |
| 4 | `RUNNER_REQUIRED`, `NATIVE_RUNTIME_PENDING` | The operation needs a different native runner or an unimplemented release component. |

## Artifact contract

Release success requires an artifact entry for the bundle, binary, manifest, test report, and validation report. Each distributable artifact must use an absolute path and include `target` and `sha256`. The pipeline must calculate hashes after packaging and verify them before returning `ok: true`.

An agent must not bypass `NATIVE_RUNTIME_PENDING`, convert warnings into success, or claim Windows/macOS support based only on portable unit tests.
