# Soundboard avatar panel (VRChat, experimental)

A Stream-Deck-style soundboard that floats in front of your VRChat avatar. Pressing a
key (your hand or another player's) sends an OSC event to the Soundboard desktop app,
which plays whatever you put on that key. Keys are set up in the desktop app, not in
Unity; the panel only shows each key's state (usable, grayed out, playing) and the
current page.

**PC avatars only** (custom shader). Needs the Soundboard desktop app on the same PC
with VRChat OSC enabled.

## Install

1. Install [VRCFury](https://vrcfury.com) in your avatar project (the only dependency
   besides the VRChat Avatars SDK).
2. Import `release/Soundboard-Avatar-Panel-<version>.unitypackage`.
3. Drag one prefab from `Assets/SoundboardPanel/Prefabs/` onto your avatar's root object:
   `SoundboardPanel 1x5` (5 keys), `3x3` (9) or `3x5` (15). Use only one per avatar.
   Pick the same grid size in the desktop app's panel editor.
4. Upload as usual. VRCFury merges the controller, parameters and menu at upload.

In VRChat: **Expressions → Soundboard → Enabled** shows the panel. The same menu picks
where it sits:

- **Follow** (default): in front of your chest, follows you with a little lag.
- **Placed in space**: stays where it was when you picked this.
- **Pickable**: also stays put, and you can grab it and move it (only you can grab it).

Turning **Enabled** off hides the panel and stops others from pressing it.

## Options

The prefab root has a **Soundboard Panel Settings** component with one option:
**Sync grayed-out keys to other players** (default on). Off saves one synced bit per
key; others then see every key as usable. It is applied when the avatar is built.

## Cost

| Grid | Contact receivers | Synced bits (option on / off) | Tris |
| --- | --- | --- | --- |
| 1×5 | 5 | 19 / 14 | 308 |
| 3×3 | 9 | 27 / 18 | 424 |
| 3×5 | 15 | 39 / 24 | 588 |

Plus 2 PhysBone components, 1 VRC constraint, 1 material and 1 mesh. Synced bits are
the values VRChat counts: Enabled 1 + Mode 8 + Playing N (+ Active N with the option on).

## Notes

- Every parameter lives under `Soundboard/v1/` (the OSC contract the desktop app
  speaks). VRCFury keeps these names unchanged.
- If your avatar also has an Android/Quest version without the panel, VRCFury makes the
  panel's parameters local-only when building that version. That's expected.
- Placed in space and Pickable freeze where the panel was when the mode changed;
  Pickable can be dragged within reach of that spot.

## Folder layout

- `Assets/SoundboardPanel/` — the raw Unity files (same as the package).
- `source/SoundboardPanel.blend` — the Blender source of the three panel meshes.
- `source/SoundboardPanelBuilder.cs.txt` — the dev-only Unity editor script that
  generated the parameters, menu, FX controllers and prefabs. Rename it to `.cs` and
  put it in an `Editor` folder to rebuild them.
- `release/` — the exported `.unitypackage`.
