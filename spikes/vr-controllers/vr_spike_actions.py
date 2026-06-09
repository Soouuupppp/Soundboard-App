r"""
Spike #2: read Index controllers via the modern SteamVR Input (action-manifest)
API instead of legacy getControllerState.

Why: the legacy path (vr_spike.py) emulates a Vive wand, which has no A button,
so VR:*:A never reports. The action API binds 1:1 to the real Index, so A (and
everything else) should come through. This spike proves that — and proves a
*background* app can drive updateActionState and that our default binding file
auto-loads — before we commit to it in the Electron sidecar.

Run (SteamVR must be running, controllers on):
    .\.venv\Scripts\python.exe vr_spike_actions.py

If actions never go "active", SteamVR may not have applied our default binding.
Fix: SteamVR → Settings → Controller Bindings → Soundboard → pick "Soundboard
Default" (or "Custom"), then re-run. Ctrl+C to quit.
"""

import json
import os
import sys
import time

try:
    import openvr
except ImportError:
    sys.exit("openvr not installed — run: pip install -r requirements.txt")

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "action_manifest", "soundboard_actions.json")
VRMANIFEST = os.path.join(HERE, "action_manifest", "soundboard.vrmanifest")

ACTION_SET = "/actions/soundboard"
APP_KEY = "soundboard.controllerbridge"
APP_NAME = "Soundboard"

# Digital actions we expect to bind, in friendly token form.
DIGITAL = [
    ("VR:LeftHand:A", "/actions/soundboard/in/left_a"),
    ("VR:LeftHand:B", "/actions/soundboard/in/left_b"),
    ("VR:LeftHand:Trigger", "/actions/soundboard/in/left_trigger"),
    ("VR:LeftHand:Grip", "/actions/soundboard/in/left_grip"),
    ("VR:LeftHand:ThumbstickClick", "/actions/soundboard/in/left_thumbstick"),
    ("VR:LeftHand:ATouch", "/actions/soundboard/in/left_a_touch"),
    ("VR:LeftHand:TrackpadTouch", "/actions/soundboard/in/left_trackpad_touch"),
    ("VR:RightHand:A", "/actions/soundboard/in/right_a"),
    ("VR:RightHand:B", "/actions/soundboard/in/right_b"),
    ("VR:RightHand:Trigger", "/actions/soundboard/in/right_trigger"),
    ("VR:RightHand:Grip", "/actions/soundboard/in/right_grip"),
    ("VR:RightHand:ThumbstickClick", "/actions/soundboard/in/right_thumbstick"),
    ("VR:RightHand:ATouch", "/actions/soundboard/in/right_a_touch"),
    ("VR:RightHand:TrackpadTouch", "/actions/soundboard/in/right_trackpad_touch"),
]
ANALOG = [
    ("VR:LeftHand:TriggerPull", "/actions/soundboard/in/left_trigger_pull"),
    ("VR:RightHand:TriggerPull", "/actions/soundboard/in/right_trigger_pull"),
]

POLL_HZ = 120


def register_app():
    """Tell SteamVR this process is "Soundboard" (not "python.exe").

    Writes a .vrmanifest (app key + display name + action-manifest path),
    installs it, then binds the running PID to that app key. Side effect: an
    *installed* app auto-applies its default_bindings, so the user no longer has
    to pick the binding by hand in SteamVR. Best-effort — a failure here only
    affects the displayed name, not input reading.
    """
    manifest = {
        "source": "builtin",
        "applications": [
            {
                "app_key": APP_KEY,
                "launch_type": "binary",
                "binary_path_windows": sys.executable,
                "arguments": os.path.abspath(__file__),
                "is_dashboard_overlay": False,
                "action_manifest_path": MANIFEST,
                "strings": {
                    "en_US": {
                        "name": APP_NAME,
                        "description": "Soundboard controller bindings",
                    }
                },
            }
        ],
    }
    try:
        with open(VRMANIFEST, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        apps = openvr.VRApplications()
        apps.addApplicationManifest(VRMANIFEST, False)  # False = persist (auto-applies bindings)
        apps.identifyApplication(os.getpid(), APP_KEY)
        print(f'Registered as "{APP_NAME}" (app key {APP_KEY}).')
    except openvr.OpenVRError as e:
        print(f"[warn] could not set app name: {e}")


def main():
    if not os.path.exists(MANIFEST):
        sys.exit(f"manifest not found: {MANIFEST}")

    print("Connecting to SteamVR as a background app…")
    try:
        openvr.init(openvr.VRApplication_Background)
    except openvr.OpenVRError as e:
        sys.exit(f"OpenVR init failed: {e}\nIs SteamVR running?")

    register_app()

    vri = openvr.VRInput()
    vri.setActionManifestPath(MANIFEST)
    print(f"Loaded action manifest:\n  {MANIFEST}\n")

    set_handle = vri.getActionSetHandle(ACTION_SET)
    digital = [(tok, vri.getActionHandle(path)) for tok, path in DIGITAL]
    analog = [(tok, vri.getActionHandle(path)) for tok, path in ANALOG]

    # One active action set, unrestricted to either hand (our actions are
    # already hand-specific by name).
    active = openvr.VRActiveActionSet_t()
    active.ulActionSet = set_handle
    active.ulRestrictedToDevice = openvr.k_ulInvalidInputValueHandle
    active.nPriority = 0
    active_arr = (openvr.VRActiveActionSet_t * 1)(active)

    invalid = openvr.k_ulInvalidInputValueHandle
    prev = {}            # token -> bool
    trig_down = {}       # token -> bool
    ever_active = False
    last_hint = 0.0

    print("Press buttons on your Index controllers. Ctrl+C to quit.\n")
    period = 1.0 / POLL_HZ
    try:
        while True:
            try:
                vri.updateActionState(active_arr)
            except openvr.OpenVRError:
                time.sleep(period)
                continue

            for tok, handle in digital:
                try:
                    d = vri.getDigitalActionData(handle, invalid)
                except openvr.OpenVRError:
                    continue
                if not d.bActive:
                    continue
                ever_active = True
                if d.bChanged:
                    print(f"{tok:28} {'down' if d.bState else 'up'}")
                prev[tok] = bool(d.bState)

            for tok, handle in analog:
                try:
                    a = vri.getAnalogActionData(handle, invalid)
                except openvr.OpenVRError:
                    continue
                if not a.bActive:
                    continue
                ever_active = True
                was = trig_down.get(tok, False)
                if not was and a.x >= 0.6:
                    trig_down[tok] = True
                    print(f"{tok:28} down  ({a.x:.2f})")
                elif was and a.x <= 0.4:
                    trig_down[tok] = False
                    print(f"{tok:28} up    ({a.x:.2f})")

            # If nothing ever binds, nudge the user toward the bindings UI.
            if not ever_active:
                now = time.time()
                if now - last_hint > 4:
                    last_hint = now
                    print("[waiting] no actions active yet — if this persists, set the "
                          "binding in SteamVR → Controller Bindings → Soundboard.")

            time.sleep(period)
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        openvr.shutdown()


if __name__ == "__main__":
    main()
