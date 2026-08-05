# three-steam 架构

## 最重要的所有权关系

```text
Steam Client
  └─ launches three-steam-host.exe
       ├─ Steamworks (first: SteamAPI_Init)
       ├─ Win32 HWND
       ├─ D3D11 device + swapchain             <- Steam Overlay hooks here
       ├─ native input / fullscreen / capture
       └─ CEF browser process
            ├─ renderer process: game JS + Three.js
            └─ GPU process: WebGL2/WebGPU output
                    │ shared D3D texture HANDLE
                    ▼
              OnAcceleratedPaint
                    │ one GPU CopyResource inside callback
                    ▼
              host-owned frame texture
                    │ native composite/present
                    ▼
              host-owned D3D11 swapchain
```

CEF 不是最后的窗口；它只是高性能 Web renderer。宿主才是游戏。

## 启动顺序

1. 解析只读配置，验证本地 `game://` 入口。
2. 如由 Steam 启动策略要求，调用 `SteamAPI_RestartAppIfNecessary`。
3. 调用 `SteamAPI_Init`，启动 callback pump。
4. 创建 Win32 窗口，但暂不假设 GPU adapter。
5. 初始化 CEF windowless rendering，启用 shared texture。
6. 第一帧 `OnAcceleratedPaint` 到达时枚举 DXGI adapter，找到能打开 shared handle 的 adapter。
7. 在该 adapter 上创建宿主 D3D11 device，立即把共享帧复制进宿主 texture。
8. 在同一 device 上创建 swapchain；之后主循环合成并 `Present`。
9. 页面调用 `host.ready()` 后关闭 loading、允许 Steam gameplay 状态和输入。

把 adapter 选择延迟到第一张共享纹理，避免双显卡笔记本上 CEF 跑核显、宿主跑独显导致
`OpenSharedResource1(E_INVALIDARG)`。设备仍在 Steam 初始化后创建，Overlay hook 顺序成立。

## 每帧路径

`OnAcceleratedPaint` 回调内：

1. 检查 texture size/format/color type。
2. 用本帧 HANDLE 调用 `OpenSharedResource1`。
3. 若尺寸变化，创建新的 host-owned texture generation。
4. `CopyResource`/`CopySubresourceRegion` 到 host-owned texture。
5. 记录单调递增 frame id，回调返回。

主呈现线程：

1. 原子地取得最新完成 generation/frame id。
2. 全屏 shader composite 到 backbuffer（处理 BGRA、色彩空间与缩放）。
3. 渲染可选的原生诊断 HUD；Steam Overlay 会在 hook 中追加自己的绘制。
4. `Present`，记录 CPU/GPU frame timing。

绝不把共享 HANDLE 缓存到下一帧。绝不从 GPU texture map/readback 到 CPU。

## Bridge

页面只看到 `three-steam` TypeScript API。传输层是 request/response JSON envelope，原生端
只接受枚举过的方法；页面不能直接调用文件系统或任意 native symbol。

首版方法组：

- `host.info`, `host.ready`, `host.quit`
- `window.getState`, `window.setFullscreen`, `window.setSize`
- `steam.user.get`, `steam.overlay.open`
- `steam.achievement.get/unlock`
- `steam.stats.get/set/store`
- `steam.presence.set/clear`
- `cloud.read/write/delete/list`

原生到页面事件：

- `overlay.changed`, `window.focus`, `window.blur`, `window.resized`
- `display.changed`, `device.lost`, `lifecycle.suspend`, `lifecycle.resume`

协议包含版本号、request id、超时、payload 上限和错误码。存档 slot 只允许安全文件名，
所有写入采用临时文件 + rename，Steam Cloud 失败不阻塞本地原子存档。

## 浏览器开发模式

同一游戏仍可在 Vite/普通浏览器运行：窗口 API 使用标准 Fullscreen API，cloud 使用
localStorage，Steam 专属调用返回明确的 `UNAVAILABLE` 或可配置 mock。禁止让 fallback
悄悄返回“成功”，否则本地测试会掩盖 Steam 集成缺失。

## 平台路线

- Phase 1：Windows x64 / D3D11 / Steam Overlay 与 OBS Game Capture。
- Phase 2：Windows 输入、IME、Steam Input、HDR/高刷、device loss soak。
- Phase 3：macOS IOSurface → Metal；需要单独验证 Valve entitlements 与 Overlay。
- Phase 4：Linux dmabuf → Vulkan/OpenGL；优先 Steam Deck X11/Wayland 实机。

接口从第一天跨平台，但发布承诺按平台测试门槛逐个打开。
