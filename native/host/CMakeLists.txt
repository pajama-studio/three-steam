cmake_minimum_required(VERSION 3.21)
project(three_steam_host VERSION 0.1.0 LANGUAGES CXX)

option(THREE_STEAM_BUILD_WINDOWS_HOST "Build the CEF/D3D11 Windows runtime" ${WIN32})
option(THREE_STEAM_BUILD_MAC_HOST "Build the CEF/Metal macOS runtime" OFF)
set(THREE_STEAM_GAME_DIR "" CACHE PATH "Directory containing the packaged index.html")
set(THREE_STEAM_GAME_ENTRY "index.html" CACHE STRING "Local HTML entry file")
set(THREE_STEAM_WINDOW_TITLE "three-steam" CACHE STRING "Native window title")
set(THREE_STEAM_WINDOW_WIDTH "1280" CACHE STRING "Initial native window width")
set(THREE_STEAM_WINDOW_HEIGHT "720" CACHE STRING "Initial native window height")
set(THREE_STEAM_WINDOW_RESIZABLE "1" CACHE STRING "Whether the native window is resizable")

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

if(THREE_STEAM_BUILD_MAC_HOST)
  if(NOT APPLE)
    message(FATAL_ERROR "The macOS host requires a macOS build machine")
  endif()
  if(NOT DEFINED ENV{CEF_ROOT})
    message(FATAL_ERROR "Set CEF_ROOT to a pinned macOS CEF binary distribution")
  endif()
  if(NOT DEFINED ENV{STEAMWORKS_SDK})
    message(FATAL_ERROR "Set STEAMWORKS_SDK to the extracted Steamworks SDK directory")
  endif()
  if(NOT THREE_STEAM_GAME_DIR OR NOT EXISTS "${THREE_STEAM_GAME_DIR}/${THREE_STEAM_GAME_ENTRY}")
    message(FATAL_ERROR "Set THREE_STEAM_GAME_DIR to a built game directory containing ${THREE_STEAM_GAME_ENTRY}")
  endif()

  enable_language(OBJCXX)
  set(PROJECT_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
  if(NOT PROJECT_ARCH STREQUAL "arm64" AND NOT PROJECT_ARCH STREQUAL "x86_64")
    message(FATAL_ERROR "Unsupported macOS architecture: ${PROJECT_ARCH}")
  endif()

  set(CEF_ROOT "$ENV{CEF_ROOT}")
  set(STEAMWORKS_SDK "$ENV{STEAMWORKS_SDK}")
  set(USE_SANDBOX ON CACHE BOOL "Enable the CEF macOS sandbox" FORCE)
  list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
  find_package(CEF REQUIRED)
  add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" "${CMAKE_BINARY_DIR}/libcef_dll_wrapper")

  set(MAC_TARGET "three-steam-host")
  set(MAC_HELPER_BASE_TARGET "three-steam-host-helper")
  set(MAC_HELPER_OUTPUT_NAME "three-steam-host Helper")
  if(CMAKE_CONFIGURATION_TYPES)
    set(MAC_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIGURATION>")
  else()
    set(MAC_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_BUILD_TYPE}")
  endif()
  set(MAC_APP "${MAC_OUTPUT_DIR}/${MAC_TARGET}.app")
  set(MAC_STEAM_DYLIB "${STEAMWORKS_SDK}/redistributable_bin/osx/libsteam_api.dylib")
  if(NOT EXISTS "${MAC_STEAM_DYLIB}")
    message(FATAL_ERROR "Missing ${MAC_STEAM_DYLIB}")
  endif()

  add_executable(${MAC_TARGET} MACOSX_BUNDLE macos/main.mm)
  SET_EXECUTABLE_TARGET_PROPERTIES(${MAC_TARGET})
  set_target_properties(${MAC_TARGET} PROPERTIES
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/macos/Info.plist.in"
    OUTPUT_NAME "${MAC_TARGET}"
    RUNTIME_OUTPUT_DIRECTORY "${MAC_OUTPUT_DIR}"
    XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "studio.pajama.three-steam.host"
  )
  target_compile_features(${MAC_TARGET} PRIVATE cxx_std_20)
  target_compile_options(${MAC_TARGET} PRIVATE -Wno-newline-eof)
  string(REPLACE "\\" "\\\\" _window_title "${THREE_STEAM_WINDOW_TITLE}")
  string(REPLACE "\"" "\\\"" _window_title "${_window_title}")
  string(REPLACE "\\" "\\\\" _game_entry "${THREE_STEAM_GAME_ENTRY}")
  string(REPLACE "\"" "\\\"" _game_entry "${_game_entry}")
  target_compile_definitions(${MAC_TARGET} PRIVATE
    THREE_STEAM_GAME_ENTRY="${_game_entry}"
    THREE_STEAM_WINDOW_TITLE="${_window_title}"
    THREE_STEAM_WINDOW_WIDTH=${THREE_STEAM_WINDOW_WIDTH}
    THREE_STEAM_WINDOW_HEIGHT=${THREE_STEAM_WINDOW_HEIGHT}
    THREE_STEAM_WINDOW_RESIZABLE=${THREE_STEAM_WINDOW_RESIZABLE}
  )
  target_include_directories(${MAC_TARGET} PRIVATE "${CEF_ROOT}")
  target_include_directories(${MAC_TARGET} SYSTEM PRIVATE "${STEAMWORKS_SDK}/public")
  target_link_libraries(${MAC_TARGET} PRIVATE
    libcef_dll_wrapper
    "${MAC_STEAM_DYLIB}"
    ${CEF_STANDARD_LIBS}
    "-framework Metal"
    "-framework QuartzCore"
    "-framework IOSurface"
  )

  COPY_MAC_FRAMEWORK(${MAC_TARGET} "${CEF_ROOT}/Release" "${MAC_APP}")

  foreach(_suffix_list ${CEF_HELPER_APP_SUFFIXES})
    string(REPLACE ":" ";" _suffix_values "${_suffix_list}")
    list(GET _suffix_values 0 _name_suffix)
    list(GET _suffix_values 1 _target_suffix)
    list(GET _suffix_values 2 _plist_suffix)
    set(_helper_target "${MAC_HELPER_BASE_TARGET}${_target_suffix}")
    set(_helper_output_name "${MAC_HELPER_OUTPUT_NAME}${_name_suffix}")
    set(_helper_plist "${CMAKE_CURRENT_BINARY_DIR}/helper-Info${_target_suffix}.plist.in")
    file(READ "${CMAKE_CURRENT_SOURCE_DIR}/macos/helper-Info.plist.in" _plist_contents)
    string(REPLACE "\${EXECUTABLE_NAME}" "${_helper_output_name}" _plist_contents "${_plist_contents}")
    string(REPLACE "\${PRODUCT_NAME}" "${_helper_output_name}" _plist_contents "${_plist_contents}")
    string(REPLACE "\${BUNDLE_ID_SUFFIX}" "${_plist_suffix}" _plist_contents "${_plist_contents}")
    file(WRITE "${_helper_plist}" "${_plist_contents}")

    add_executable(${_helper_target} MACOSX_BUNDLE macos/process_helper.mm)
    SET_EXECUTABLE_TARGET_PROPERTIES(${_helper_target})
    set_target_properties(${_helper_target} PROPERTIES
      MACOSX_BUNDLE_INFO_PLIST "${_helper_plist}"
      OUTPUT_NAME "${_helper_output_name}"
      RUNTIME_OUTPUT_DIRECTORY "${MAC_OUTPUT_DIR}"
      XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "studio.pajama.three-steam.host.helper${_plist_suffix}"
    )
    target_include_directories(${_helper_target} PRIVATE "${CEF_ROOT}")
    target_link_libraries(${_helper_target} PRIVATE libcef_dll_wrapper ${CEF_STANDARD_LIBS})
    add_dependencies(${MAC_TARGET} ${_helper_target})
    add_custom_command(TARGET ${MAC_TARGET} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${MAC_OUTPUT_DIR}/${_helper_output_name}.app"
        "${MAC_APP}/Contents/Frameworks/${_helper_output_name}.app"
      VERBATIM
    )
  endforeach()

  add_custom_command(TARGET ${MAC_TARGET} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${MAC_APP}/Contents/Resources/game"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${THREE_STEAM_GAME_DIR}" "${MAC_APP}/Contents/Resources/game"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MAC_STEAM_DYLIB}" "${MAC_APP}/Contents/MacOS/libsteam_api.dylib"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CEF_ROOT}/LICENSE.txt" "${MAC_APP}/Contents/Resources/CEF_LICENSE.txt"
    VERBATIM
  )
endif()
