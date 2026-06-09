#include <cstdio>

// Minimal toolchain sanity check: confirms cl.exe compiles + links a real exe
// via CMake's MSVC generator (the exact path the VR sidecar build will use).
int main() {
    std::printf("toolchain OK: compiled and linked with MSVC\n");
    return 0;
}
