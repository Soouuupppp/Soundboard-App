// vr-bridge — Soundboard's Valve Index controller listener.
//
// A *background* OpenVR app (no rendering, no focus, doesn't steal input) that
// reads Index controllers via the SteamVR Input action system and prints button
// edges to stdout as line-delimited JSON. Electron's vr-controllers.js spawns
// it and forwards the tokens into the same playback pipeline the keyboard hook
// uses.
//
// Protocol (one JSON object per line, stdout):
//   {"t":"status","steamvr":true|false}      connection state changes
//   {"t":"down","token":"VR:RightHand:A"}    button / threshold pressed
//   {"t":"up","token":"VR:RightHand:A"}      released
//
// CLI:
//   --actions <path>   action manifest JSON (default: <exeDir>/soundboard_actions.json)
//   --data    <dir>    writable dir for the generated .vrmanifest (default: <exeDir>)
//
// The exe dir is read-only once installed under Program Files, so the .vrmanifest
// (which names us "Soundboard" and auto-applies the default binding) is written
// into --data, which Electron points at its userData directory.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <openvr.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono_literals;

static const char* kActionSet = "/actions/soundboard";
static const char* kAppKey = "soundboard.controllerbridge";

// Analog trigger-pull → digital edge with hysteresis (matches the spike).
static const float kTrigDown = 0.6f;
static const float kTrigUp = 0.4f;

// ---- output helpers --------------------------------------------------------

static void emit(const std::string& line) {
    std::fputs(line.c_str(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}
static void emitStatus(bool steamvr) {
    emit(std::string("{\"t\":\"status\",\"steamvr\":") + (steamvr ? "true" : "false") + "}");
}
static void emitEdge(const char* type, const std::string& token) {
    emit(std::string("{\"t\":\"") + type + "\",\"token\":\"" + token + "\"}");
}

// ---- path / json helpers ---------------------------------------------------

static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '\\' || c == '"') out.push_back('\\');
        out.push_back(c);
    }
    return out;
}
static std::string exePath() {
    char buf[MAX_PATH];
    DWORD n = GetModuleFileNameA(nullptr, buf, MAX_PATH);
    return std::string(buf, n);
}
static std::string dirOf(const std::string& p) {
    auto pos = p.find_last_of("\\/");
    return pos == std::string::npos ? std::string(".") : p.substr(0, pos);
}

// ---- action table ----------------------------------------------------------

struct Digital {
    std::string token;
    std::string path;
    vr::VRActionHandle_t handle = vr::k_ulInvalidActionHandle;
    bool active = false;  // tracked only for completeness
};
struct Analog {
    std::string token;
    std::string path;
    vr::VRActionHandle_t handle = vr::k_ulInvalidActionHandle;
    bool down = false;
};

static std::vector<Digital> makeDigital() {
    std::vector<Digital> v;
    auto add = [&](const char* tok, const char* name) {
        v.push_back({tok, std::string("/actions/soundboard/in/") + name});
    };
    add("VR:LeftHand:A", "left_a");
    add("VR:LeftHand:B", "left_b");
    add("VR:LeftHand:Trigger", "left_trigger");
    add("VR:LeftHand:Grip", "left_grip");
    add("VR:LeftHand:ThumbstickClick", "left_thumbstick");
    add("VR:LeftHand:ATouch", "left_a_touch");
    add("VR:LeftHand:TrackpadTouch", "left_trackpad_touch");
    add("VR:RightHand:A", "right_a");
    add("VR:RightHand:B", "right_b");
    add("VR:RightHand:Trigger", "right_trigger");
    add("VR:RightHand:Grip", "right_grip");
    add("VR:RightHand:ThumbstickClick", "right_thumbstick");
    add("VR:RightHand:ATouch", "right_a_touch");
    add("VR:RightHand:TrackpadTouch", "right_trackpad_touch");

    // Quest/Touch lives in a SEPARATE token namespace ("VRQ:") so its binds never
    // collide with Index ("VR:"). Both action sets are always registered; only the
    // ones the active controller's binding maps actually fire, so on an Index only
    // VR:* emit and on a Touch only VRQ:* emit. Keep in sync with web/src/lib/
    // vr-bind.ts (QUEST_LEFT_KEYS / QUEST_RIGHT_KEYS) + bindings_touch.json.
    add("VRQ:LeftHand:X", "quest_left_x");
    add("VRQ:LeftHand:XTouch", "quest_left_x_touch");
    add("VRQ:LeftHand:Y", "quest_left_y");
    add("VRQ:LeftHand:YTouch", "quest_left_y_touch");
    add("VRQ:LeftHand:Trigger", "quest_left_trigger");
    add("VRQ:LeftHand:TriggerTouch", "quest_left_trigger_touch");
    add("VRQ:LeftHand:Grip", "quest_left_grip");
    add("VRQ:LeftHand:ThumbstickClick", "quest_left_thumbstick");
    add("VRQ:LeftHand:ThumbstickTouch", "quest_left_thumbstick_touch");
    add("VRQ:LeftHand:ThumbrestTouch", "quest_left_thumbrest_touch");
    add("VRQ:LeftHand:Menu", "quest_left_menu");
    add("VRQ:RightHand:A", "quest_right_a");
    add("VRQ:RightHand:ATouch", "quest_right_a_touch");
    add("VRQ:RightHand:B", "quest_right_b");
    add("VRQ:RightHand:BTouch", "quest_right_b_touch");
    add("VRQ:RightHand:Trigger", "quest_right_trigger");
    add("VRQ:RightHand:TriggerTouch", "quest_right_trigger_touch");
    add("VRQ:RightHand:Grip", "quest_right_grip");
    add("VRQ:RightHand:ThumbstickClick", "quest_right_thumbstick");
    add("VRQ:RightHand:ThumbstickTouch", "quest_right_thumbstick_touch");
    add("VRQ:RightHand:ThumbrestTouch", "quest_right_thumbrest_touch");
    return v;
}
static std::vector<Analog> makeAnalog() {
    return {
        {"VR:LeftHand:TriggerPull", "/actions/soundboard/in/left_trigger_pull"},
        {"VR:RightHand:TriggerPull", "/actions/soundboard/in/right_trigger_pull"},
    };
}

// ---- app registration (names us "Soundboard", auto-applies bindings) -------

static void writeVrManifest(const std::string& path, const std::string& exe,
                            const std::string& actionsPath,
                            const std::string& iconPath) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) return;
    f << "{\n"
      << "  \"source\": \"builtin\",\n"
      << "  \"applications\": [{\n"
      << "    \"app_key\": \"" << kAppKey << "\",\n"
      << "    \"launch_type\": \"binary\",\n"
      << "    \"binary_path_windows\": \"" << jsonEscape(exe) << "\",\n"
      << "    \"is_dashboard_overlay\": false,\n"
      << "    \"action_manifest_path\": \"" << jsonEscape(actionsPath) << "\",\n"
      << "    \"image_path\": \"" << jsonEscape(iconPath) << "\",\n"
      << "    \"strings\": { \"en_US\": { \"name\": \"Soundboard\", "
         "\"description\": \"Soundboard controller bindings\" } }\n"
      << "  }]\n"
      << "}\n";
}

static void registerApp(const std::string& vrmanifestPath) {
    auto* apps = vr::VRApplications();
    if (!apps) return;
    vr::EVRApplicationError e = apps->AddApplicationManifest(vrmanifestPath.c_str(), false);
    if (e != vr::VRApplicationError_None) {
        std::fprintf(stderr, "[vr-bridge] AddApplicationManifest error %d (%s)\n",
                     e, vr::VRApplications()->GetApplicationsErrorNameFromEnum(e));
    }
    e = apps->IdentifyApplication(GetCurrentProcessId(), kAppKey);
    if (e != vr::VRApplicationError_None) {
        std::fprintf(stderr, "[vr-bridge] IdentifyApplication error %d (%s)\n",
                     e, vr::VRApplications()->GetApplicationsErrorNameFromEnum(e));
    }
}

// ---- one connected SteamVR session ----------------------------------------
// Returns when SteamVR quits (or setup fails); caller reconnects.

static void runSession(vr::IVRSystem* sys, const std::string& actionsPath,
                       const std::string& vrmanifestPath, const std::string& exe,
                       const std::string& iconPath) {
    writeVrManifest(vrmanifestPath, exe, actionsPath, iconPath);
    registerApp(vrmanifestPath);

    auto* input = vr::VRInput();
    if (!input) return;

    if (input->SetActionManifestPath(actionsPath.c_str()) != vr::VRInputError_None) {
        std::fprintf(stderr, "[vr-bridge] SetActionManifestPath failed (%s)\n", actionsPath.c_str());
        return;
    }

    vr::VRActionSetHandle_t setHandle = vr::k_ulInvalidActionSetHandle;
    input->GetActionSetHandle(kActionSet, &setHandle);

    auto digital = makeDigital();
    auto analog = makeAnalog();
    for (auto& d : digital) input->GetActionHandle(d.path.c_str(), &d.handle);
    for (auto& a : analog) input->GetActionHandle(a.path.c_str(), &a.handle);

    vr::VRActiveActionSet_t actionSet{};
    actionSet.ulActionSet = setHandle;
    actionSet.ulRestrictedToDevice = vr::k_ulInvalidInputValueHandle;

    emitStatus(true);

    for (;;) {
        // Drain events; bail out cleanly when SteamVR shuts down.
        vr::VREvent_t ev{};
        while (sys->PollNextEvent(&ev, sizeof(ev))) {
            if (ev.eventType == vr::VREvent_Quit) {
                return;  // caller shuts us down and waits to reconnect
            }
        }

        input->UpdateActionState(&actionSet, sizeof(actionSet), 1);

        for (auto& d : digital) {
            vr::InputDigitalActionData_t data{};
            if (input->GetDigitalActionData(d.handle, &data, sizeof(data),
                                            vr::k_ulInvalidInputValueHandle) != vr::VRInputError_None)
                continue;
            if (data.bActive && data.bChanged) emitEdge(data.bState ? "down" : "up", d.token);
        }

        for (auto& a : analog) {
            vr::InputAnalogActionData_t data{};
            if (input->GetAnalogActionData(a.handle, &data, sizeof(data),
                                           vr::k_ulInvalidInputValueHandle) != vr::VRInputError_None)
                continue;
            if (!data.bActive) continue;
            if (!a.down && data.x >= kTrigDown) {
                a.down = true;
                emitEdge("down", a.token);
            } else if (a.down && data.x <= kTrigUp) {
                a.down = false;
                emitEdge("up", a.token);
            }
        }

        std::this_thread::sleep_for(8ms);  // ~120 Hz
    }
}

// Exit if our parent (Electron) goes away: when it dies the stdin pipe closes
// and fread hits EOF. Prevents orphaned sidecars.
static void watchStdinForExit() {
    std::thread([] {
        char c;
        while (std::fread(&c, 1, 1, stdin) == 1) { /* ignore input */ }
        std::exit(0);
    }).detach();
}

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IONBF, 0);

    std::string actionsPath, dataDir;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--actions" && i + 1 < argc) actionsPath = argv[++i];
        else if (a == "--data" && i + 1 < argc) dataDir = argv[++i];
    }
    const std::string exe = exePath();
    const std::string dir = dirOf(exe);
    if (actionsPath.empty()) actionsPath = dir + "\\soundboard_actions.json";
    if (dataDir.empty()) dataDir = dir;
    const std::string vrmanifestPath = dataDir + "\\soundboard.vrmanifest";
    const std::string iconPath = dir + "\\icon.png";

    watchStdinForExit();

    bool announcedDisconnected = false;
    for (;;) {
        vr::EVRInitError err = vr::VRInitError_None;
        vr::IVRSystem* sys = vr::VR_Init(&err, vr::VRApplication_Background);
        if (err != vr::VRInitError_None || !sys) {
            if (!announcedDisconnected) {
                emitStatus(false);
                announcedDisconnected = true;
            }
            std::this_thread::sleep_for(2s);
            continue;
        }
        announcedDisconnected = false;

        runSession(sys, actionsPath, vrmanifestPath, exe, iconPath);

        vr::VR_Shutdown();
        emitStatus(false);
        announcedDisconnected = true;
        std::this_thread::sleep_for(2s);  // brief pause before reconnecting
    }
    return 0;
}
