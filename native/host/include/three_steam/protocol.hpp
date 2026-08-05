#pragma once

#include <cstddef>
#include <string_view>

namespace three_steam {

inline constexpr int kProtocolVersion = 1;
inline constexpr std::size_t kMaxRequestBytes = 256 * 1024;
inline constexpr std::size_t kMaxSaveBytes = 8 * 1024 * 1024;

[[nodiscard]] bool IsKnownMethod(std::string_view method) noexcept;
[[nodiscard]] bool IsSafeIdentifier(std::string_view value) noexcept;
[[nodiscard]] bool IsSafeSaveName(std::string_view value) noexcept;
[[nodiscard]] bool IsRequestSizeAllowed(std::size_t bytes) noexcept;
[[nodiscard]] bool IsSaveSizeAllowed(std::size_t bytes) noexcept;

}  // namespace three_steam
