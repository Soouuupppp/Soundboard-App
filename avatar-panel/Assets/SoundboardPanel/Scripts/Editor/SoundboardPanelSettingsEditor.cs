// Inspector for SoundboardPanelSettings. The sync option itself is applied when the
// avatar is built (SoundboardPanelBuildHook): VRCFury reverts any override made on its
// components in a prefab instance, so the inspector can't change the Full Controller.
using UnityEditor;
using UnityEngine;

namespace SoundboardPanel.Editor
{
    [CustomEditor(typeof(SoundboardPanelSettings))]
    public class SoundboardPanelSettingsEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            EditorGUILayout.HelpBox(
                "Soundboard avatar panel. Keys are set up in the Soundboard desktop app, not here. " +
                "Requires VRCFury. PC avatars only.", MessageType.None);
            var sync = serializedObject.FindProperty("syncGrayedOutKeys");
            sync.boolValue = EditorGUILayout.ToggleLeft(
                new GUIContent("Sync grayed-out keys to other players",
                    "On: others also see which keys are grayed out (1 synced bit per key). Off: only you do."),
                sync.boolValue);
            var s = (SoundboardPanelSettings)target;
            if (s.syncedParams == null || s.localParams == null)
                EditorGUILayout.HelpBox("This panel's parameter assets are missing. Re-add the prefab.", MessageType.Warning);
            serializedObject.ApplyModifiedProperties();
        }
    }
}
