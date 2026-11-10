cmake_minimum_required(VERSION 3.20)
project(audio_capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Static CRT (/MT) so the shipped exe needs no VC++ redistributable on users'
# machines. Requires CMP0091=NEW, which is the default at this cmake_minimum.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(audio-capture WIN32 src/main.cpp)
target_compile_definitions(audio-capture PRIVATE UNICODE _UNICODE NOMINMAX)
target_link_libraries(audio-capture PRIVATE ole32 mmdevapi avrt version)
