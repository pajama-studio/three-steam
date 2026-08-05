# Release validation gates

`three-steam` does not claim a platform is supported until every P0 gate passes
on that platform. A successful compile is not a successful runtime.

## Windows x64 P0

| Gate | Pass condition |
|---|---|
| Steam init order | Trace proves `SteamAPI_Init` completes before the first D3D device is created. |
| Overlay | Overlay hint renders; Shift+Tab opens/closes it 20/20 times; browser, chat and screenshot UI are legible. |
| Native presentation | PresentMon attributes the foreground swapchain to `three-steam-host.exe`, not a CEF subprocess. |
| Process isolation | CEF renderer and GPU remain separate; command line contains neither `--in-process-gpu` nor `--single-process`. |
| No CPU paint | Release telemetry records zero `OnPaint` callbacks and accelerated frames greater than zero. |
| Frame transport | CEF handles are opened and copied only during `OnAcceleratedPaint`; stale-handle sanitizer test passes. |
| Multi-GPU | Integrated/discrete combinations select an adapter that can open the shared resource, or stop with an actionable error. |
| Resize/fullscreen | 100 window/fullscreen/DPI transitions show no black frame longer than two presents and no stale-size copy. |
| Input | Keyboard, mouse, wheel, pointer lock, XInput/Steam Input, IME composition and focus loss all round-trip correctly. |
| Steamworks | User, achievements, stats callbacks, overlay state, rich presence and cloud save pass with a non-480 test app. |
| Capture | Steam screenshot and OBS Game Capture capture the composed game, not a blank/child window. |
| Recovery | GPU reset/device removal produces one controlled renderer restart without save loss. |
| Security | Production navigation cannot leave `game://`; DevTools and remote debugging are disabled; bridge rejects unknown methods. |

## Performance budgets

- 1920×1080 at 60 Hz: p95 present interval <= 18.2 ms on the reference low GPU.
- 2560×1440 at 120 Hz: p95 host compositor GPU time <= 0.8 ms on the reference mid GPU.
- Host overhead excluding CEF: <= 150 MB working set at 1080p.
- No-frame-change idle: no forced 60 Hz invalidation; presentation may downshift.
- One GPU copy per new CEF frame, zero texture readbacks in a 30-minute capture.
- Input-to-present p95 regression versus Chrome fullscreen <= 8 ms.

## Required test matrix

- Windows 10 22H2 and Windows 11 current.
- Intel iGPU, AMD iGPU, NVIDIA discrete, AMD discrete, Optimus/hybrid laptop.
- 60/120/144 Hz, 100/125/150/200% DPI, one and two monitors.
- Steam stable and beta clients.
- WebGL2 mandatory; WebGPU is enabled only after the same matrix passes.

## Ship blockers

- Falling back from accelerated paint to CPU pixels.
- Requiring `--in-process-gpu` for Overlay.
- Overlay visible but transparent/black/stale.
- Caching or using a CEF shared handle after callback return.
- Silently switching adapters or software rasterization.
- Exposing Node.js, arbitrary filesystem access, or arbitrary native method names to game content.
