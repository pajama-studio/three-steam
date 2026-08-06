#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>

#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_load_handler.h"
#include "include/cef_parser.h"
#include "include/cef_render_handler.h"
#include "include/cef_resource_handler.h"
#include "include/cef_scheme.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_library_loader.h"
#include "steam/steam_api.h"

#ifndef THREE_STEAM_GAME_ENTRY
#define THREE_STEAM_GAME_ENTRY "index.html"
#endif
#ifndef THREE_STEAM_WINDOW_TITLE
#define THREE_STEAM_WINDOW_TITLE "three-steam"
#endif
#ifndef THREE_STEAM_WINDOW_WIDTH
#define THREE_STEAM_WINDOW_WIDTH 1280
#endif
#ifndef THREE_STEAM_WINDOW_HEIGHT
#define THREE_STEAM_WINDOW_HEIGHT 720
#endif
#ifndef THREE_STEAM_WINDOW_RESIZABLE
#define THREE_STEAM_WINDOW_RESIZABLE 1
#endif

constexpr char kGameScheme[] = "game";
constexpr char kGameDomain[] = "app";
constexpr int kGameSchemeOptions = CEF_SCHEME_OPTION_STANDARD |
                                   CEF_SCHEME_OPTION_SECURE |
                                   CEF_SCHEME_OPTION_CORS_ENABLED |
                                   CEF_SCHEME_OPTION_FETCH_ENABLED;

class HostController;

@interface ThreeSteamApplication : NSApplication <CefAppProtocol> {
 @private
  BOOL handlingSendEvent_;
}
@end

@implementation ThreeSteamApplication
- (BOOL)isHandlingSendEvent { return handlingSendEvent_; }
- (void)setHandlingSendEvent:(BOOL)value { handlingSendEvent_ = value; }
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sending_event;
  [super sendEvent:event];
}
@end

@interface MetalGameView : NSView {
 @private
  id<MTLDevice> device_;
  id<MTLCommandQueue> queue_;
  CefRefPtr<CefBrowser> browser_;
}
- (instancetype)initWithFrame:(NSRect)frame;
- (void)setBrowser:(CefRefPtr<CefBrowser>)browser;
- (BOOL)presentIOSurface:(IOSurfaceRef)surface format:(cef_color_type_t)format;
@end

int EventModifiers(NSEvent* event) {
  int modifiers = 0;
  const NSEventModifierFlags flags = [event modifierFlags];
  if (flags & NSEventModifierFlagShift) modifiers |= EVENTFLAG_SHIFT_DOWN;
  if (flags & NSEventModifierFlagControl) modifiers |= EVENTFLAG_CONTROL_DOWN;
  if (flags & NSEventModifierFlagOption) modifiers |= EVENTFLAG_ALT_DOWN;
  if (flags & NSEventModifierFlagCommand) modifiers |= EVENTFLAG_COMMAND_DOWN;
  if (flags & NSEventModifierFlagCapsLock) modifiers |= EVENTFLAG_CAPS_LOCK_ON;
  return modifiers;
}

CefMouseEvent MouseEventForView(MetalGameView* view, NSEvent* event) {
  const NSPoint point = [view convertPoint:[event locationInWindow] fromView:nil];
  CefMouseEvent mouse_event;
  mouse_event.x = static_cast<int>(point.x);
  // MetalGameView is flipped, so convertPoint already returns top-left view
  // coordinates as expected by CEF. Flipping again mirrors every click.
  mouse_event.y = static_cast<int>(point.y);
  mouse_event.modifiers = EventModifiers(event);
  return mouse_event;
}

@implementation MetalGameView
- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  device_ = MTLCreateSystemDefaultDevice();
  queue_ = [device_ newCommandQueue];
  CAMetalLayer* metal_layer = [CAMetalLayer layer];
  metal_layer.device = device_;
  metal_layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
  metal_layer.framebufferOnly = YES;
  metal_layer.opaque = YES;
  metal_layer.contentsScale = [[NSScreen mainScreen] backingScaleFactor];
  [self setLayer:metal_layer];
  [self setWantsLayer:YES];
  return self;
}

- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent*)event { return YES; }
- (BOOL)isFlipped { return YES; }

- (void)setBrowser:(CefRefPtr<CefBrowser>)browser { browser_ = browser; }

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  const CGFloat scale = [[self window] backingScaleFactor] ?: 1.0;
  CAMetalLayer* metal_layer = static_cast<CAMetalLayer*>([self layer]);
  metal_layer.contentsScale = scale;
  metal_layer.drawableSize = CGSizeMake(newSize.width * scale, newSize.height * scale);
  if (browser_) browser_->GetHost()->WasResized();
}

- (BOOL)presentIOSurface:(IOSurfaceRef)surface format:(cef_color_type_t)format {
  if (!surface || !device_ || !queue_) return NO;
  if (format != CEF_COLOR_TYPE_BGRA_8888) return NO;

  const size_t width = IOSurfaceGetWidth(surface);
  const size_t height = IOSurfaceGetHeight(surface);
  if (width == 0 || height == 0) return NO;

  CAMetalLayer* metal_layer = static_cast<CAMetalLayer*>([self layer]);
  metal_layer.drawableSize = CGSizeMake(width, height);
  id<CAMetalDrawable> drawable = [metal_layer nextDrawable];
  if (!drawable) return NO;

  MTLTextureDescriptor* descriptor =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                         width:width
                                                        height:height
                                                     mipmapped:NO];
  descriptor.storageMode = MTLStorageModeShared;
  descriptor.usage = MTLTextureUsageShaderRead;
  id<MTLTexture> source = [device_ newTextureWithDescriptor:descriptor
                                                  iosurface:surface
                                                      plane:0];
  if (!source) return NO;

  id<MTLCommandBuffer> command_buffer = [queue_ commandBuffer];
  id<MTLBlitCommandEncoder> blit = [command_buffer blitCommandEncoder];
  const NSUInteger copy_width = std::min(source.width, drawable.texture.width);
  const NSUInteger copy_height = std::min(source.height, drawable.texture.height);
  [blit copyFromTexture:source
            sourceSlice:0
            sourceLevel:0
           sourceOrigin:MTLOriginMake(0, 0, 0)
             sourceSize:MTLSizeMake(copy_width, copy_height, 1)
              toTexture:drawable.texture
       destinationSlice:0
       destinationLevel:0
      destinationOrigin:MTLOriginMake(0, 0, 0)];
  [blit endEncoding];
  [command_buffer presentDrawable:drawable];
  [command_buffer commit];
  [command_buffer waitUntilCompleted];
  return command_buffer.status == MTLCommandBufferStatusCompleted;
}

- (void)mouseMoved:(NSEvent*)event {
  if (browser_) browser_->GetHost()->SendMouseMoveEvent(MouseEventForView(self, event), false);
}
- (void)mouseDragged:(NSEvent*)event { [self mouseMoved:event]; }
- (void)rightMouseDragged:(NSEvent*)event { [self mouseMoved:event]; }
- (void)otherMouseDragged:(NSEvent*)event { [self mouseMoved:event]; }

- (void)mouseDown:(NSEvent*)event {
  [[self window] makeFirstResponder:self];
  if (browser_) browser_->GetHost()->SendMouseClickEvent(
      MouseEventForView(self, event), MBT_LEFT, false, static_cast<int>([event clickCount]));
}
- (void)mouseUp:(NSEvent*)event {
  if (browser_) browser_->GetHost()->SendMouseClickEvent(
      MouseEventForView(self, event), MBT_LEFT, true, static_cast<int>([event clickCount]));
}
- (void)rightMouseDown:(NSEvent*)event {
  if (browser_) browser_->GetHost()->SendMouseClickEvent(
      MouseEventForView(self, event), MBT_RIGHT, false, static_cast<int>([event clickCount]));
}
- (void)rightMouseUp:(NSEvent*)event {
  if (browser_) browser_->GetHost()->SendMouseClickEvent(
      MouseEventForView(self, event), MBT_RIGHT, true, static_cast<int>([event clickCount]));
}
- (void)scrollWheel:(NSEvent*)event {
  if (browser_) browser_->GetHost()->SendMouseWheelEvent(
      MouseEventForView(self, event), static_cast<int>([event scrollingDeltaX]),
      static_cast<int>([event scrollingDeltaY]));
}

- (void)sendKeyEvent:(NSEvent*)event type:(cef_key_event_type_t)type {
  if (!browser_) return;
  CefKeyEvent key_event;
  key_event.type = type;
  key_event.modifiers = EventModifiers(event);
  key_event.native_key_code = static_cast<int>([event keyCode]);
  NSString* characters = [event characters];
  NSString* unmodified = [event charactersIgnoringModifiers];
  if ([characters length] > 0) key_event.character = [characters characterAtIndex:0];
  if ([unmodified length] > 0) {
    key_event.unmodified_character = [unmodified characterAtIndex:0];
    key_event.windows_key_code = key_event.unmodified_character;
  }
  browser_->GetHost()->SendKeyEvent(key_event);
}
- (void)keyDown:(NSEvent*)event {
  [self sendKeyEvent:event type:KEYEVENT_RAWKEYDOWN];
  [self sendKeyEvent:event type:KEYEVENT_CHAR];
}
- (void)keyUp:(NSEvent*)event { [self sendKeyEvent:event type:KEYEVENT_KEYUP]; }
@end

std::string MimeTypeForPath(const std::filesystem::path& path) {
  const std::string extension = path.extension().string();
  if (extension == ".html") return "text/html";
  if (extension == ".js" || extension == ".mjs") return "text/javascript";
  if (extension == ".css") return "text/css";
  if (extension == ".json") return "application/json";
  if (extension == ".wasm") return "application/wasm";
  if (extension == ".png") return "image/png";
  if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
  if (extension == ".webp") return "image/webp";
  if (extension == ".svg") return "image/svg+xml";
  if (extension == ".glb") return "model/gltf-binary";
  if (extension == ".gltf") return "model/gltf+json";
  if (extension == ".mp3") return "audio/mpeg";
  if (extension == ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

class GameResourceHandler final : public CefResourceHandler {
 public:
  explicit GameResourceHandler(std::filesystem::path root) : root_(std::move(root)) {}

  bool Open(CefRefPtr<CefRequest> request,
            bool& handle_request,
            CefRefPtr<CefCallback> callback) override {
    CEF_REQUIRE_IO_THREAD();
    handle_request = true;
    CefURLParts parts;
    if (!CefParseURL(request->GetURL(), parts)) return false;
    std::string path = CefString(&parts.path).ToString();
    path = CefURIDecode(path, false, UU_PATH_SEPARATORS).ToString();
    while (!path.empty() && path.front() == '/') path.erase(path.begin());
    if (path.empty()) path = "index.html";
    if (path.find("..") != std::string::npos || path.find('\\') != std::string::npos) return false;

    const std::filesystem::path candidate = (root_ / path).lexically_normal();
    const auto root_string = root_.lexically_normal().string();
    const auto candidate_string = candidate.string();
    const std::string root_prefix = root_string + "/";
    if (candidate_string.size() < root_prefix.size() ||
        candidate_string.compare(0, root_prefix.size(), root_prefix) != 0) return false;

    stream_.open(candidate, std::ios::binary);
    if (!stream_) return false;
    stream_.seekg(0, std::ios::end);
    length_ = static_cast<int64_t>(stream_.tellg());
    stream_.seekg(0, std::ios::beg);
    mime_type_ = MimeTypeForPath(candidate);
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t& response_length,
                          CefString& redirect_url) override {
    CEF_REQUIRE_IO_THREAD();
    response->SetStatus(200);
    response->SetStatusText("OK");
    response->SetMimeType(mime_type_);
    response_length = length_;
  }

  bool Read(void* data_out,
            int bytes_to_read,
            int& bytes_read,
            CefRefPtr<CefResourceReadCallback> callback) override {
    CEF_REQUIRE_IO_THREAD();
    if (!stream_ || bytes_to_read <= 0) {
      bytes_read = 0;
      return false;
    }
    stream_.read(static_cast<char*>(data_out), bytes_to_read);
    bytes_read = static_cast<int>(stream_.gcount());
    return bytes_read > 0;
  }

  void Cancel() override { stream_.close(); }

 private:
  const std::filesystem::path root_;
  std::ifstream stream_;
  int64_t length_ = 0;
  std::string mime_type_;
  IMPLEMENT_REFCOUNTING(GameResourceHandler);
};

class GameSchemeFactory final : public CefSchemeHandlerFactory {
 public:
  explicit GameSchemeFactory(std::filesystem::path root) : root_(std::move(root)) {}

  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
    if (scheme_name != kGameScheme) return nullptr;
    return new GameResourceHandler(root_);
  }

 private:
  const std::filesystem::path root_;
  IMPLEMENT_REFCOUNTING(GameSchemeFactory);
};

class HostController {
 public:
  HostController() {
    const NSRect frame = NSMakeRect(0, 0, THREE_STEAM_WINDOW_WIDTH, THREE_STEAM_WINDOW_HEIGHT);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable;
    if (THREE_STEAM_WINDOW_RESIZABLE) style |= NSWindowStyleMaskResizable;
    window_ = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:style
                    backing:NSBackingStoreBuffered
                      defer:NO];
    [window_ setTitle:[NSString stringWithUTF8String:THREE_STEAM_WINDOW_TITLE]];
    [window_ center];
    view_ = [[MetalGameView alloc] initWithFrame:frame];
    [window_ setContentView:view_];
    [window_ makeFirstResponder:view_];
    [window_ setAcceptsMouseMovedEvents:YES];
    [window_ makeKeyAndOrderFront:nil];
  }

  ~HostController() {
    [view_ setBrowser:nullptr];
    [view_ release];
    [window_ release];
  }

  void CreateBrowser(CefRefPtr<CefClient> client) {
    CEF_REQUIRE_UI_THREAD();
    CefWindowInfo window_info;
    window_info.SetAsWindowless(static_cast<CefWindowHandle>(view_));
    window_info.shared_texture_enabled = true;
    CefBrowserSettings settings;
    settings.background_color = CefColorSetARGB(255, 16, 25, 35);
    const std::string entry_url = std::string("game://app/") + THREE_STEAM_GAME_ENTRY;
    if (!CefBrowserHost::CreateBrowser(window_info, client, entry_url, settings,
                                       nullptr, nullptr)) {
      load_failed_.store(true);
      CefQuitMessageLoop();
    }
  }

  void SetBrowser(CefRefPtr<CefBrowser> browser) {
    browser_ = browser;
    [view_ setBrowser:browser];
  }

  void CloseBrowser() {
    if (browser_) browser_->GetHost()->CloseBrowser(false);
    else CefQuitMessageLoop();
  }

  void BrowserClosed() {
    [view_ setBrowser:nullptr];
    browser_ = nullptr;
    CefQuitMessageLoop();
  }

  void MarkLoaded() { page_loaded_.store(true); }
  void MarkLoadFailed() { load_failed_.store(true); }
  void MarkCpuPaint() { cpu_paint_frames_.fetch_add(1); }

  void Present(const CefAcceleratedPaintInfo& info) {
    accelerated_callbacks_.fetch_add(1);
    IOSurfaceRef surface = static_cast<IOSurfaceRef>(info.shared_texture_io_surface);
    if ([view_ presentIOSurface:surface format:info.format]) {
      presented_frames_.fetch_add(1);
    } else {
      present_failures_.fetch_add(1);
    }
  }

  void WriteReport(bool steam_available) const {
    const char* report_path = std::getenv("THREE_STEAM_RUNTIME_REPORT");
    if (!report_path || !*report_path) return;
    std::ofstream report(report_path, std::ios::trunc);
    report << "{\n"
           << "  \"schemaVersion\": 1,\n"
           << "  \"renderer\": \"metal\",\n"
           << "  \"steamAvailable\": " << (steam_available ? "true" : "false") << ",\n"
           << "  \"pageLoaded\": " << (page_loaded_.load() ? "true" : "false") << ",\n"
           << "  \"loadFailed\": " << (load_failed_.load() ? "true" : "false") << ",\n"
           << "  \"acceleratedCallbacks\": " << accelerated_callbacks_.load() << ",\n"
           << "  \"presentedFrames\": " << presented_frames_.load() << ",\n"
           << "  \"presentFailures\": " << present_failures_.load() << ",\n"
           << "  \"cpuPaintFrames\": " << cpu_paint_frames_.load() << "\n"
           << "}\n";
  }

  MetalGameView* view() const { return view_; }

 private:
  NSWindow* window_ = nil;
  MetalGameView* view_ = nil;
  CefRefPtr<CefBrowser> browser_;
  std::atomic<bool> page_loaded_{false};
  std::atomic<bool> load_failed_{false};
  std::atomic<uint64_t> accelerated_callbacks_{0};
  std::atomic<uint64_t> presented_frames_{0};
  std::atomic<uint64_t> present_failures_{0};
  std::atomic<uint64_t> cpu_paint_frames_{0};
};

class BrowserClient final : public CefClient,
                            public CefLifeSpanHandler,
                            public CefLoadHandler,
                            public CefRenderHandler {
 public:
  explicit BrowserClient(HostController* controller) : controller_(controller) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    controller_->SetBrowser(browser);
  }

  bool DoClose(CefRefPtr<CefBrowser> browser) override { return false; }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    controller_->BrowserClosed();
  }

  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int http_status_code) override {
    if (frame->IsMain() && http_status_code < 400) controller_->MarkLoaded();
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode error_code,
                   const CefString& error_text,
                   const CefString& failed_url) override {
    if (frame->IsMain()) controller_->MarkLoadFailed();
  }

  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
    const NSRect bounds = [controller_->view() bounds];
    rect = CefRect(0, 0, std::max(1, static_cast<int>(bounds.size.width)),
                   std::max(1, static_cast<int>(bounds.size.height)));
  }

  bool GetScreenInfo(CefRefPtr<CefBrowser> browser, CefScreenInfo& info) override {
    info.device_scale_factor = [[controller_->view() window] backingScaleFactor] ?: 1.0;
    return true;
  }

  void OnPaint(CefRefPtr<CefBrowser> browser,
               PaintElementType type,
               const RectList& dirty_rects,
               const void* buffer,
               int width,
               int height) override {
    controller_->MarkCpuPaint();
  }

  void OnAcceleratedPaint(CefRefPtr<CefBrowser> browser,
                          PaintElementType type,
                          const RectList& dirty_rects,
                          const CefAcceleratedPaintInfo& info) override {
    if (type == PET_VIEW) controller_->Present(info);
  }

 private:
  HostController* const controller_;
  IMPLEMENT_REFCOUNTING(BrowserClient);
};

class BrowserApp final : public CefApp, public CefBrowserProcessHandler {
 public:
  BrowserApp(HostController* controller, std::filesystem::path game_root)
      : controller_(controller), game_root_(std::move(game_root)) {}

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(kGameScheme, kGameSchemeOptions);
  }

  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override {
    if (process_type.empty()) command_line->AppendSwitch("use-mock-keychain");
  }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    CefRegisterSchemeHandlerFactory(kGameScheme, kGameDomain,
                                    new GameSchemeFactory(game_root_));
    controller_->CreateBrowser(new BrowserClient(controller_));
  }

 private:
  HostController* const controller_;
  const std::filesystem::path game_root_;
  IMPLEMENT_REFCOUNTING(BrowserApp);
};

@interface HostDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate> {
 @private
  HostController* controller_;
}
- (instancetype)initWithController:(HostController*)controller;
@end

@implementation HostDelegate
- (instancetype)initWithController:(HostController*)controller {
  self = [super init];
  if (self) controller_ = controller;
  return self;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender { return YES; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
  controller_->CloseBrowser();
  return NSTerminateCancel;
}
@end

void InstallApplicationMenu() {
  NSMenu* menu_bar = [[[NSMenu alloc] init] autorelease];
  NSMenuItem* app_item = [[[NSMenuItem alloc] init] autorelease];
  [menu_bar addItem:app_item];
  [NSApp setMainMenu:menu_bar];
  NSMenu* app_menu = [[[NSMenu alloc] initWithTitle:@"three-steam-host"] autorelease];
  NSMenuItem* quit_item = [[[NSMenuItem alloc]
      initWithTitle:@"Quit three-steam-host"
             action:@selector(terminate:)
      keyEquivalent:@"q"] autorelease];
  [app_menu addItem:quit_item];
  [app_item setSubmenu:app_menu];
}

int main(int argc, char* argv[]) {
  // Steam must be initialized before CEF loads or Metal creates a device.
  const bool steam_available = SteamAPI_Init();
  if (!steam_available && std::getenv("THREE_STEAM_ALLOW_NO_STEAM") == nullptr) {
    return 11;
  }

  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInMain()) {
    if (steam_available) SteamAPI_Shutdown();
    return 10;
  }

  @autoreleasepool {
    [ThreeSteamApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    InstallApplicationMenu();

    NSString* root_string = [[NSBundle mainBundle] pathForResource:@"game" ofType:nil];
    if (!root_string) {
      if (steam_available) SteamAPI_Shutdown();
      return 12;
    }

    HostController controller;
    HostDelegate* delegate = [[HostDelegate alloc] initWithController:&controller];
    [NSApp setDelegate:delegate];
    [[controller.view() window] setDelegate:delegate];
    [NSApp activateIgnoringOtherApps:YES];

    CefMainArgs main_args(argc, argv);
    CefSettings settings;
    settings.windowless_rendering_enabled = true;
    settings.background_color = CefColorSetARGB(255, 16, 25, 35);
    NSString* cache_root = [NSTemporaryDirectory()
        stringByAppendingPathComponent:@"studio.pajama.three-steam.cef"];
    CefString(&settings.root_cache_path) = [cache_root fileSystemRepresentation];
    CefRefPtr<BrowserApp> app =
        new BrowserApp(&controller, std::filesystem::path([root_string fileSystemRepresentation]));
    if (!CefInitialize(main_args, settings, app, nullptr)) {
      [delegate release];
      if (steam_available) SteamAPI_Shutdown();
      return 13;
    }

    NSTimer* steam_timer = nil;
    if (steam_available) {
      steam_timer = [NSTimer scheduledTimerWithTimeInterval:(1.0 / 30.0)
                                                    repeats:YES
                                                      block:^(NSTimer*) { SteamAPI_RunCallbacks(); }];
    }
    const char* smoke_seconds_value = std::getenv("THREE_STEAM_SMOKE_SECONDS");
    NSTimer* smoke_timer = nil;
    if (smoke_seconds_value) {
      const double seconds = std::max(1.0, std::strtod(smoke_seconds_value, nullptr));
      HostController* controller_ptr = &controller;
      smoke_timer = [NSTimer scheduledTimerWithTimeInterval:seconds
                                                    repeats:NO
                                                      block:^(NSTimer*) { controller_ptr->CloseBrowser(); }];
    }

    CefRunMessageLoop();
    [smoke_timer invalidate];
    [steam_timer invalidate];
    controller.WriteReport(steam_available);
    CefShutdown();
    [delegate release];
    if (steam_available) SteamAPI_Shutdown();
  }
  return 0;
}
