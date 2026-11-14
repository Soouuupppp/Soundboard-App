// Applies SoundboardPanelSettings.syncGrayedOutKeys when an avatar is built (upload,
// VRCFury test copy, play mode). It runs before VRCFury (order -10000) and points each
// panel's Full Controller at the synced or local parameters asset on the copy being
// built. VRCFury's model types are internal, so its serialized data is edited by path.
using UnityEditor;
using UnityEngine;
using VRC.SDKBase.Editor.BuildPipeline;

namespace SoundboardPanel.Editor
{
    public class SoundboardPanelBuildHook : IVRCSDKPreprocessAvatarCallback
    {
        public int callbackOrder => -20000;

        const string ParamsProp = "content.prms.Array.data[0].parameters";

        public bool OnPreprocessAvatar(GameObject avatar)
        {
            foreach (var s in avatar.GetComponentsInChildren<SoundboardPanelSettings>(true))
            {
                var want = s.syncGrayedOutKeys ? s.syncedParams : s.localParams;
                if (want == null) continue;
                if (!SetParams(s.gameObject, want))
                    Debug.LogWarning($"Soundboard panel: couldn't apply the sync option on {s.name} (VRCFury Full Controller not found).", s);
            }
            return true;
        }

        static bool SetParams(GameObject go, Object prms)
        {
            foreach (var c in go.GetComponents<Component>())
            {
                if (c == null || c.GetType().FullName != "VF.Model.VRCFury") continue;
                var so = new SerializedObject(c);
                var p = so.FindProperty(ParamsProp);
                var obj = p?.FindPropertyRelative("objRef");
                var id = p?.FindPropertyRelative("id");
                if (obj == null || id == null) continue;
                if (obj.objectReferenceValue == prms) return true;
                var path = AssetDatabase.GetAssetPath(prms);
                obj.objectReferenceValue = prms;
                id.stringValue = AssetDatabase.AssetPathToGUID(path) + "|" + path; // VRCFury's id format for a main asset
                so.ApplyModifiedPropertiesWithoutUndo();
                return true;
            }
            return false;
        }
    }
}
