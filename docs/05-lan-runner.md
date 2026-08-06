# Secure Mac/Windows LAN runner

The LAN runner lets one Codex session coordinate native checks on macOS and Windows
without exposing SSH, PowerShell, or an arbitrary remote shell.

## Security model

- The runner listens on localhost unless LAN access is explicitly requested.
- Pairing uses a six-digit, one-time code with a ten-minute window and five-attempt limit.
- X25519 + HKDF derives an ephemeral pairing key; AES-256-GCM protects the token exchange.
- Every later request is HMAC-signed with a timestamp and unique nonce.
- Replayed, expired, modified, unknown, or oversized requests are rejected.
- Only `capabilities`, `doctor`, `plan`, `build`, `smoke`, and `pipeline` are allowed.
- Path arguments must resolve inside the checked-out repository.
- The runner stores controller tokens only in memory. Restarting it requires pairing again.

Do not forward ports `47731` or `47732` to the public internet. The provided firewall
rules apply only to the Windows Private network profile.

## Windows Codex handoff

On the Windows x64 machine, clone or pull the exact commit used on the Mac. From an
Administrator PowerShell prompt, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\start-windows-runner.ps1 -ConfigureFirewall
```

Without Administrator access, ask the user to add the two Private-profile firewall
rules once, then run the script without `-ConfigureFirewall`.

The runner prints exactly one JSON object. Read both the six-digit code and `runnerId`
fingerprint from that Windows console and keep the process open. The Mac requires both,
so an unrelated LAN host cannot silently replace the runner. Do not paste or commit
runner credentials.

## Mac controller

Discover the runner:

```bash
node dist/cli/main.js remote discover --seconds 2 --json \
  --report artifacts/remote/discover.json
```

If UDP broadcast is blocked, use the Windows IP directly:

```bash
node dist/cli/main.js remote pair \
  --host WINDOWS_LAN_IP \
  --port 47731 \
  --runner-id WINDOWS_RUNNER_ID \
  --code SIX_DIGIT_CODE \
  --credential artifacts/private/claystation.json \
  --json \
  --report artifacts/remote/pair.json
```

Check status and run the Windows-native doctor:

```bash
node dist/cli/main.js remote status \
  --credential artifacts/private/claystation.json \
  --json \
  --report artifacts/remote/status.json

node dist/cli/main.js remote run \
  --credential artifacts/private/claystation.json \
  --command doctor \
  --json \
  --report artifacts/remote/windows-doctor-controller.json \
  -- --config three-steam.config.example.json --target windows-x64
```

## Two-host matrix

`matrix` first compares Git revisions and refuses to mix results from different
commits. It then runs the same operation on both native hosts concurrently and writes
a combined local report under `artifacts/matrix/`.

```bash
node dist/cli/main.js matrix \
  --credential artifacts/private/claystation.json \
  --command doctor \
  --config three-steam.config.example.json \
  --remote-config three-steam.config.example.json \
  --json \
  --report artifacts/matrix/doctor-controller.json
```

`--allow-revision-mismatch` exists only for protocol development. Never use it for a
release claim. A green portable matrix still does not replace the target-hardware P0
gates in `docs/03-validation-gates.md`.

## Troubleshooting

- `REMOTE_UNAVAILABLE`: confirm the runner window is open and TCP `47731` is allowed.
- Discovery empty but direct pairing works: allow UDP `47732` on the Private profile.
- `REMOTE_AUTH_FAILED`: restart the runner and pair again; credentials are session-bound.
- `REVISION_MISMATCH`: fetch and checkout the same commit on both machines.
- `NATIVE_RUNTIME_PENDING`: expected until the matching native runtime passes all P0 gates.
