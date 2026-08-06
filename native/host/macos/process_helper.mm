#include "include/cef_app.h"
#include "include/cef_scheme.h"
#include "include/wrapper/cef_library_loader.h"

#if defined(CEF_USE_SANDBOX)
#include "include/cef_sandbox_mac.h"
#endif

namespace {

constexpr char kGameScheme[] = "game";
constexpr int kGameSchemeOptions = CEF_SCHEME_OPTION_STANDARD |
                                   CEF_SCHEME_OPTION_SECURE |
                                   CEF_SCHEME_OPTION_CORS_ENABLED |
                                   CEF_SCHEME_OPTION_FETCH_ENABLED;

class HelperApp final : public CefApp {
 public:
  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(kGameScheme, kGameSchemeOptions);
  }

 private:
  IMPLEMENT_REFCOUNTING(HelperApp);
};

}  // namespace

int main(int argc, char* argv[]) {
#if defined(CEF_USE_SANDBOX)
  CefScopedSandboxContext sandbox_context;
  if (!sandbox_context.Initialize(argc, argv)) return 1;
#endif

  CefScopedLibraryLoader loader;
  if (!loader.LoadInHelper()) return 2;

  CefMainArgs main_args(argc, argv);
  return CefExecuteProcess(main_args, new HelperApp(), nullptr);
}
