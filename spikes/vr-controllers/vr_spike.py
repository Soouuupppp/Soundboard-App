"""
Spike: can we observe Valve Index (Knuckles) controller buttons from a
*background* OpenVR app — no rendering, no focus, without stealing input from
the running game/SteamVR Home?

This is a throwaway proof of concept for the Index-only controller-bindings
feature. If this prints button edges cleanly while you mash the controllers,
the real feature (a C++/Python sidecar feeding electron/vr-controllers.js) is a
known quantity. If OpenVR fights us here, we've burned minutes, not a week.

Run:
    pip install -r requirements.txt
    python vr_spike.py

Requires SteamVR to be running with the Index controllers powered on.
Ctrl+C to quit.
"""

import sys
import time

try:
    import openvr
except ImportError:
    sys.exit("openvr not installed — run: pip install -r requirements.txt")


# Legacy button ids we care about for a soundboard, mapped to friendly names.
# On the Index these all come through SteamVR's legacy binding compatibility.
BUTTONS = {
    openvr.k_EButton_System: "System",
    openvr.k_EButton_ApplicationMenu: "B",          # Index B button
    openvr.k_EButton_Grip: "Grip",
    openvr.k_EButton_A: "A",                         # Index A button
    openvr.k_EButton_SteamVR_Touchpad: "ThumbstickClick",
    openvr.k_EButton_SteamVR_Trigger: "Trigger",
}

# Analog trigger pull is reported on axis 1 (x). We threshold it into a clean
# down/up edge with hysteresis so a slow squeeze doesn't chatter.
TRIGGER_AXIS = 1
TRIG_DOWN = 0.6
TRIG_UP = 0.4

POLL_HZ = 120


def hand_label(vr, index):
    role = vr.getControllerRoleForTrackedDeviceIndex(index)
    if role == openvr.TrackedControllerRole_LeftHand:
        return "LeftHand"
    if role == openvr.TrackedControllerRole_RightHand:
        return "RightHand"
    return f"Device{index}"


def main():
    print("Connecting to SteamVR as a background app…")
    try:
        vr = openvr.init(openvr.VRApplication_Background)
    except openvr.OpenVRError as e:
        sys.exit(
            f"OpenVR init failed: {e}\n"
            "Is SteamVR running? Background apps still need the runtime up."
        )

    print("Connected. Press buttons on your Index controllers. Ctrl+C to quit.\n")

    # Per-device remembered state so we only print transitions (edges).
    prev_pressed = {}   # index -> ulButtonPressed mask
    trig_down = {}      # index -> bool

    period = 1.0 / POLL_HZ
    try:
        while True:
            for i in range(openvr.k_unMaxTrackedDeviceCount):
                if vr.getTrackedDeviceClass(i) != openvr.TrackedDeviceClass_Controller:
                    continue
                got, state = vr.getControllerState(i)
                if not got:
                    continue

                hand = hand_label(vr, i)

                # --- Digital buttons (edge-detected via the pressed bitmask) ---
                pressed = state.ulButtonPressed
                changed = pressed ^ prev_pressed.get(i, 0)
                if changed:
                    for btn_id, name in BUTTONS.items():
                        mask = 1 << btn_id  # == OpenVR's ButtonMaskFromId macro
                        if changed & mask:
                            edge = "down" if (pressed & mask) else "up"
                            token = f"VR:{hand}:{name}"
                            print(f"{token:28} {edge}")
                    prev_pressed[i] = pressed

                # --- Analog trigger → synthesized down/up with hysteresis ---
                pull = state.rAxis[TRIGGER_AXIS].x
                was_down = trig_down.get(i, False)
                if not was_down and pull >= TRIG_DOWN:
                    trig_down[i] = True
                    print(f"{f'VR:{hand}:TriggerPull':28} down  ({pull:.2f})")
                elif was_down and pull <= TRIG_UP:
                    trig_down[i] = False
                    print(f"{f'VR:{hand}:TriggerPull':28} up    ({pull:.2f})")

            time.sleep(period)
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        openvr.shutdown()


if __name__ == "__main__":
    main()
