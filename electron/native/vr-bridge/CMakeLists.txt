cmake_minimum_required(VERSION 3.20)
project(vr_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Static CRT (/MT) so the shipped exe needs no VC++ redistributable on users'
# machines. Requires CMP0091=NEW, which is the default at this cmake_minimum.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(OPENVR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/openvr")

add_executable(vr-bridge src/main.cpp)
target_include_directories(vr-bridge PRIVATE "${OPENVR_DIR}/include")
target_link_libraries(vr-bridge PRIVATE "${OPENVR_DIR}/lib/win64/openvr_api.lib")

# openvr_api is a DLL with an import lib; ship the DLL next to the exe.
add_custom_command(TARGET vr-bridge POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${OPENVR_DIR}/bin/win64/openvr_api.dll"
    "$<TARGET_FILE_DIR:vr-bridge>/openvr_api.dll"
  VERBATIM)

# Ship the action manifest + default binding next to the exe so the bridge runs
# self-contained (Electron points --actions at this copy in packaged builds).
add_custom_command(TARGET vr-bridge POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/manifests/soundboard_actions.json"
    "$<TARGET_FILE_DIR:vr-bridge>/soundboard_actions.json"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/manifests/bindings_knuckles.json"
    "$<TARGET_FILE_DIR:vr-bridge>/bindings_knuckles.json"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/manifests/bindings_touch.json"
    "$<TARGET_FILE_DIR:vr-bridge>/bindings_touch.json"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/../../assets/icon.png"
    "$<TARGET_FILE_DIR:vr-bridge>/icon.png"
  VERBATIM)
