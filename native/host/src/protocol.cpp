#include "three_steam/protocol.hpp"

#include <algorithm>
#include <array>

namespace three_steam {
namespace {

constexpr std::array<std::string_view, 19> kMethods{
    "cloud.delete",
    "cloud.list",
    "cloud.read",
    "cloud.write",
    "host.info",
    "host.quit",
    "host.ready",
    "steam.achievement.get",
    "steam.achievement.unlock",
    "steam.overlay.open",
    "steam.presence.clear",
    "steam.presence.set",
    "steam.stats.get",
    "steam.stats.set",
    "steam.stats.store",
    "steam.user.get",
    "window.getState",
    "window.setFullscreen",
    "window.setSize",
};

constexpr bool IsIdentifierCharacter(char character) noexcept {
  return (character >= 'A' && character <= 'Z') ||
         (character >= 'a' && character <= 'z') ||
         (character >= '0' && character <= '9') || character == '.' ||
         character == '_' || character == '-';
}

}  // namespace

bool IsKnownMethod(std::string_view method) noexcept {
  return std::find(kMethods.begin(), kMethods.end(), method) != kMethods.end();
}

bool IsSafeIdentifier(std::string_view value) noexcept {
  return !value.empty() && value.size() <= 96 &&
         ((value.front() >= 'A' && value.front() <= 'Z') ||
          (value.front() >= 'a' && value.front() <= 'z') ||
          (value.front() >= '0' && value.front() <= '9')) &&
         std::all_of(value.begin(), value.end(), IsIdentifierCharacter);
}

bool IsSafeSaveName(std::string_view value) noexcept {
  return IsSafeIdentifier(value) && value.front() != '.' &&
         value.find("..") == std::string_view::npos;
}

bool IsRequestSizeAllowed(std::size_t bytes) noexcept {
  return bytes > 0 && bytes <= kMaxRequestBytes;
}

bool IsSaveSizeAllowed(std::size_t bytes) noexcept {
  return bytes <= kMaxSaveBytes;
}

}  // namespace three_steam
