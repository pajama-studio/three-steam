# Twister & Skydancer native demo

This integration packages the real Twister & Skydancer WebGL/WebGPU game instead of a
synthetic smoke page. The game bundle is intentionally not duplicated in this
repository while Twister & Skydancer is private. The importer accepts only the
MIT-licensed `skydancer` project and keeps its generated `dist/` untracked.

```bash
npm --prefix /path/to/skydancer run build:web
node examples/skydancer/import.mjs --source /path/to/skydancer

three-steam build \
  --config examples/skydancer/three-steam.config.json \
  --target macos-arm64 \
  --cef-root /path/to/cef \
  --steamworks-sdk /path/to/steamworks_sdk.zip \
  --json --report artifacts/skydancer/build.json

three-steam smoke \
  --config examples/skydancer/three-steam.config.json \
  --target macos-arm64 \
  --seconds 15 \
  --json --report artifacts/skydancer/smoke.json
```

`--allow-no-steam` may be added only for local GPU smoke work. Before a Steam
claim, start the Steam client and rerun without that flag using an owned app ID.

After the Twister & Skydancer repository is public, replace the local-source step with a
pinned repository revision so CI can reproduce the demo without copying game
source or licensed SDK binaries into `three-steam`.
