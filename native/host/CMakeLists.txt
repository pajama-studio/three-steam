cmake_minimum_required(VERSION 3.21)
project(three_steam_host VERSION 0.1.0 LANGUAGES CXX)

option(THREE_STEAM_BUILD_WINDOWS_HOST "Build the CEF/D3D11 Windows runtime" ${WIN32})

add_library(three_steam_core STATIC
  src/protocol.cpp
)
target_include_directories(three_steam_core PUBLIC include)
target_compile_features(three_steam_core PUBLIC cxx_std_20)
set_target_properties(three_steam_core PROPERTIES CXX_EXTENSIONS OFF)

if(MSVC)
  target_compile_options(three_steam_core PRIVATE /W4 /WX /permissive-)
else()
  target_compile_options(three_steam_core PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()
add_executable(three_steam_core_tests tests/protocol_test.cpp)
target_link_libraries(three_steam_core_tests PRIVATE three_steam_core)
add_test(NAME three_steam_core_tests COMMAND three_steam_core_tests)

if(THREE_STEAM_BUILD_WINDOWS_HOST)
  if(NOT WIN32)
    message(FATAL_ERROR "The Windows host requires a Windows MSVC build machine")
  endif()
  if(NOT DEFINED ENV{CEF_ROOT})
    message(FATAL_ERROR "Set CEF_ROOT to the pinned CEF binary distribution")
  endif()
  if(NOT DEFINED ENV{STEAMWORKS_SDK})
    message(FATAL_ERROR "Set STEAMWORKS_SDK to your licensed Steamworks SDK")
  endif()
  message(FATAL_ERROR "The Windows CEF/D3D11 runtime is not implemented on main yet; do not treat the protocol-core build as a native host")
endif()
