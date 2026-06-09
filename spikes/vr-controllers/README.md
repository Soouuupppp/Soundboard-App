# Spike: Index controller passthrough listening

Throwaway proof of concept for the **Index/VR-only controller bindings**
feature. Goal: confirm we can *observe* Valve Index button presses from a
**background** OpenVR app — without rendering, without focus, without stealing
input from the game — the VR analogue of how `electron/hotkeys.js` observes the
keyboard via `uiohook-napi`.

## Run

```powershell
# from this folder
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python vr_spike.py
```

**SteamVR must be running** with the Index controllers powered on. Mash the
buttons; you should see lines like:

```
VR:RightHand:A               down
VR:RightHand:A               up
VR:LeftHand:Grip             down
VR:RightHand:TriggerPull     down  (0.71)
```

`Ctrl+C` to quit.

## What a pass tells us

- Background polling of `getControllerState` works on the Index → the real
  feature can be a small sidecar emitting these same `VR:<hand>:<button>`
  tokens into the existing IPC pipeline.
- The token strings here are the proposed binding format for the new
  `boardEntry.controllerBind` column.

## Spike #2 — action-manifest path (gets the A button)

`vr_spike.py` uses legacy `getControllerState`, which emulates a Vive wand and
**can't see the Index A button**. `vr_spike_actions.py` uses the modern SteamVR
Input API with an explicit action manifest + Knuckles binding file, which binds
1:1 to the real controller.

```powershell
.\.venv\Scripts\python.exe vr_spike_actions.py
```

Files:
- `action_manifest/soundboard_actions.json` — action set + per-hand actions.
- `action_manifest/bindings_knuckles.json` — default Index binding.

A pass = `VR:RightHand:A down` prints (the thing legacy couldn't do). If actions
never go active, SteamVR didn't apply our default binding — open SteamVR →
Settings → Controller Bindings → Soundboard and select it, then re-run.

## If it fails

- `OpenVR init failed` → SteamVR isn't running, or the runtime can't be found.
- Buttons print nothing → legacy `getControllerState` may be gated; fallback is
  the action-manifest (SteamVR Input) API, which is heavier. Note which buttons
  do/don't report.
