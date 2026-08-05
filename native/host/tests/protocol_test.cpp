#include "three_steam/protocol.hpp"

#include <cassert>

int main() {
  using namespace three_steam;
  static_assert(kProtocolVersion == 1);
  assert(IsKnownMethod("host.info"));
  assert(IsKnownMethod("window.setSize"));
  assert(!IsKnownMethod("filesystem.execute"));
  assert(IsSafeIdentifier("FIRST_STORM-1"));
  assert(!IsSafeIdentifier(".hidden"));
  assert(!IsSafeIdentifier("../secret"));
  assert(IsSafeSaveName("save-01.json"));
  assert(!IsSafeSaveName("../save.json"));
  assert(IsRequestSizeAllowed(kMaxRequestBytes));
  assert(!IsRequestSizeAllowed(kMaxRequestBytes + 1));
  assert(IsSaveSizeAllowed(kMaxSaveBytes));
  assert(!IsSaveSizeAllowed(kMaxSaveBytes + 1));
  return 0;
}
