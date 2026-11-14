// Editor-only settings for the Soundboard avatar panel prefab. Removed at upload
// (IEditorOnly); its inspector swaps the VRCFury Full Controller's parameters asset.
using UnityEngine;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace SoundboardPanel
{
    [DisallowMultipleComponent]
    [AddComponentMenu("Soundboard/Soundboard Panel Settings")]
    public class SoundboardPanelSettings : MonoBehaviour, VRC.SDKBase.IEditorOnly
    {
        [Tooltip("On: other players also see which keys are grayed out (costs 1 synced bit per key). " +
                 "Off: only you see grayed-out keys; others see every key as usable.")]
        public bool syncGrayedOutKeys = true;

        [HideInInspector] public VRCExpressionParameters syncedParams;
        [HideInInspector] public VRCExpressionParameters localParams;
    }
}
