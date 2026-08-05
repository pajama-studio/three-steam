# Three.js 游戏上 Steam：既有方案与故障史

调研快照：2026-08-05。这里把“能打开一个 HTML 页面”和“能作为 Steam 游戏
稳定发布”严格分开。后者至少包含硬件加速、Overlay、Steamworks、手柄、输入法、
全屏、截图/录制、休眠恢复、云存档和可预测的帧调度。

## 结论

现有工具覆盖了“打包”和“调用 Steamworks”，但没有一个开源通用包同时保证：

1. Chromium 保持安全的多进程 GPU 架构；
2. Steam Overlay 钩住游戏自己的原生 swapchain；
3. Three.js 画面不经过 CPU readback；
4. Steamworks C++ SDK 不经过 Node native-addon ABI；
5. 版本更新不依赖实验性 `--in-process-gpu` 行为。

`three-steam` 的机会不是再做 Electron builder，而是补上这个原生呈现层。

## 谁做过

| 路线 | 已有项目/团队 | 做成了什么 | 历史问题 |
|---|---|---|---|
| Electron/NW.js + Node addon | Greenworks、steamworks.js、很多 Construct/RPG Maker 游戏 | HTML5 打包、成就、存档、Overlay 可在部分版本工作 | Chromium GPU 通常在子进程；Overlay workaround 依赖 `--in-process-gpu` 和 `--disable-direct-composition`。steamworks.js 还会每秒 60 次强制 `invalidate()` 以避免 Overlay 不刷新。Electron/Chromium 升级可能改变这些非产品契约。|
| Tauri/Wry + WebView2 | Tauri、Construct 的 Windows WebView2 exporter | 包体很小、系统 Chromium、C++/Rust bridge | WebView2 的 D3D device 在 `msedgewebview2.exe`，不是宿主游戏进程。Steam Overlay 无法可靠钩住。WebView2 团队在 issue #3200 明确解释宿主不拥有 WebView2 的 D3D device。|
| WebView2 + 额外透明 D3D 层 | Construct 团队技术实验 | 尝试给 Overlay 一个宿主 swapchain | DirectComposition 只接受 premultiplied alpha，而 Steam Overlay 的输出行为不匹配，合成结果错误；实验最终判定不可用。|
| Electron 产品化包装 | GemShell | GUI 打包、Steamworks bridge、跨平台构建部署 | 文档显示当前仍基于 Electron 33.3.1，因此没有消除 Electron GPU 进程/Overlay workaround、Node 权限和 ABI 风险。它是直接竞品，但解决的是易用性，不是呈现架构。|
| Construct 自建 wrapper extension | Scirra/Construct | JSON bridge、C++ 扩展 DLL、WebView2 Windows 与 CEF Linux 路线 | 证明“稳定 JSON ABI + 原生 SDK”方向正确；但 Windows WebView2 仍有 Overlay 根因，不能作为我们的最终 compositor。|
| Steam HTML Surface | Valve | Steamworks 内置 CEF，可在已有游戏中显示 HTML 页面 | 它是供原生游戏嵌入网页 UI 的接口，不是让 HTML 游戏拥有原生最终 swapchain 的通用 runtime；生命周期和渲染也依赖 Steam client。|
| CEF off-screen rendering | CEF、OBS Browser、多个游戏 UI 集成 | 独立 Chromium、可自定义协议/输入/渲染；当前 API 提供跨平台 accelerated texture handles | 集成工作重；必须正确处理共享 handle 生命周期、GPU adapter、resize、IME、popup、device loss 和打包。正是本项目要产品化的部分。|

## Electron/NW.js workaround 为什么不作为基础

steamworks.js 当前实现不是简单调用一个“启用 Overlay”的 API。它实际执行：

```text
--in-process-gpu
--disable-direct-composition
60 Hz webContents.invalidate()
```

这会把 Chromium 的 GPU 工作塞回主进程，并持续制造 repaint。优点是 Steam
终于能看到主进程图形调用；代价是依赖 Chromium 非稳定命令行行为、破坏 GPU
故障隔离、空闲时也产生刷新成本。其 issue #102 仍记录了 Windows、Linux、macOS
均无法显示 Overlay 的复现。

Greenworks 目前仓库仍有维护活动，不能简单称为“已死”；但它基于 NAN/node-gyp，
依然与 Node/Electron/NW ABI 绑定。Construct 团队记录了每次 NW.js 更新都需要重编
native addon 的维护成本。three-steam 不让 Steamworks 进入 Node 进程，直接在稳定
C++ host ABI 中调用。

## Tauri/WebView2 为什么结构上解决不了

WebView2 的窗口中还有跨进程的 `msedgewebview2.exe` child HWND。WebView2 官方工程师
指出：WebView2 不在宿主应用中创建或使用宿主的 D3D device。因此即使 Tauri 先调用
`SteamAPI_Init`，实际游戏帧仍由另一个进程呈现。

`--in-process-gpu` 对完整 Chromium/Electron 是把 browser/GPU 合并；对 WebView2 只能
合并 WebView2 自己的进程，不能把它并入 Tauri 宿主。这个差别就是 Overlay 失败的根因。

## CEF accelerated OSR 现在提供了什么

当前 `CefRenderHandler::OnAcceleratedPaint` 文档给出明确的跨平台资源：

- Windows：可用 D3D11 `OpenSharedResource1` 或 D3D12 `OpenSharedHandle` 打开的 HANDLE；
- macOS：可由 Metal/OpenGL 打开的 IOSurface；
- Linux：native buffer 的 fd/planes。

CEF 使用资源池，所以 handle 每帧可能变化，回调结束后就失效。正确做法是在回调内
每次重新打开，并复制到宿主自己拥有的 GPU texture；不能缓存 handle，也不能回调结束
后再读取。于是我们的准确性能承诺是：**零 CPU 像素回读，一次 GPU texture copy**，
而不是不真实的“绝对零拷贝”。

## 被否决的路径

- **继续 Tauri 并写 Steam 插件**：插件能调用 Steamworks，不能改变谁创建最终 D3D device。
- **Electron + steamworks.js 直接发布**：适合快速 demo，但无法把实验性 flag 变成我们的稳定契约。
- **透明窗口盖在 WebView2 上**：已有完整失败记录，alpha/compositor/输入/全屏都会继续出问题。
- **CEF software OnPaint**：1080p60 每秒约 498 MB 原始 BGRA 写入，还不含额外拷贝；3D 游戏不可接受。
- **Steam HTML Surface 当主引擎**：控制权、部署与平台适用范围不符合独立 runtime。
- **先做三平台**：会把 Windows Overlay 的核心验证稀释。先把最大 Steam 市场的 D3D11 路径做实。

## 选定路线

Windows x64 MVP：C++20 + Win32 + D3D11 + CEF accelerated OSR + Steamworks SDK。

CEF 可以继续使用 GPU 子进程；它通过 shared handle 把最终网页纹理交给宿主。宿主在
回调有效期内做 GPU copy，随后把自己的 texture 呈现到自己创建的 swapchain。
`SteamAPI_Init` 在任何 D3D device 创建前调用，所以 Steam Overlay 钩的是稳定、标准、
由游戏主进程拥有的 D3D11 呈现路径。

## 主要资料

- Steam Overlay 初始化与支持 API：<https://partner.steamgames.com/doc/features/overlay>
- WebView2/Tauri Overlay 根因：<https://github.com/MicrosoftEdge/WebView2Feedback/issues/3200>
- Construct 的失败实验：<https://www.construct.net/en/blogs/ashleys-blog-2/trying-show-steam-overlay-1861>
- Construct wrapper/ABI 经验：<https://www.construct.net/en/blogs/construct-official-blog-1/new-architecture-publishing-1864>
- steamworks.js：<https://github.com/ceifa/steamworks.js>
- Greenworks：<https://github.com/greenheartgames/greenworks>
- GemShell Electron 基础：<https://gemshell.dev/guide/getting-started>
- CEF 项目：<https://github.com/chromiumembedded/cef>
- CEF accelerated paint 契约：<https://cef-builds.spotifycdn.com/docs/149.0/classCefRenderHandler.html>
- OBS 的生产 CEF 集成：<https://github.com/obsproject/obs-browser>
