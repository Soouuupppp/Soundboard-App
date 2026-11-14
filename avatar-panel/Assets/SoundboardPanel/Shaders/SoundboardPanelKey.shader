// Soundboard avatar panel: unlit key shader driven by per-key material floats.
// The mesh's second UV set carries the key index in x (0..14 keys, -1 body,
// 100..109 page dots) and 1 in y on a key's front face. The FX controller animates
// _Active<n> / _Playing<n> / _Pressed<n> / _Page from the Soundboard/v1 parameters,
// so the whole panel is one draw call with no textures.
Shader "Soundboard/PanelKey"
{
    Properties
    {
        _BodyColor ("Body", Color) = (0.07, 0.075, 0.09, 1)
        _KeyColor ("Key (active)", Color) = (0.20, 0.23, 0.30, 1)
        _InactiveColor ("Key (grayed out)", Color) = (0.10, 0.10, 0.11, 1)
        _PlayingColor ("Key (playing)", Color) = (0.55, 0.95, 0.25, 1)
        _PressedColor ("Key (pressed flash)", Color) = (1, 1, 1, 1)
        _DotColor ("Page dot", Color) = (0.20, 0.21, 0.25, 1)
        _DotLitColor ("Page dot (current)", Color) = (0.45, 0.75, 1, 1)
        _Page ("Page (0-based)", Float) = 0
        [HideInInspector] _Active0 ("Active 0", Float) = 1
        [HideInInspector] _Active1 ("Active 1", Float) = 1
        [HideInInspector] _Active2 ("Active 2", Float) = 1
        [HideInInspector] _Active3 ("Active 3", Float) = 1
        [HideInInspector] _Active4 ("Active 4", Float) = 1
        [HideInInspector] _Active5 ("Active 5", Float) = 1
        [HideInInspector] _Active6 ("Active 6", Float) = 1
        [HideInInspector] _Active7 ("Active 7", Float) = 1
        [HideInInspector] _Active8 ("Active 8", Float) = 1
        [HideInInspector] _Active9 ("Active 9", Float) = 1
        [HideInInspector] _Active10 ("Active 10", Float) = 1
        [HideInInspector] _Active11 ("Active 11", Float) = 1
        [HideInInspector] _Active12 ("Active 12", Float) = 1
        [HideInInspector] _Active13 ("Active 13", Float) = 1
        [HideInInspector] _Active14 ("Active 14", Float) = 1
        [HideInInspector] _Playing0 ("Playing 0", Float) = 0
        [HideInInspector] _Playing1 ("Playing 1", Float) = 0
        [HideInInspector] _Playing2 ("Playing 2", Float) = 0
        [HideInInspector] _Playing3 ("Playing 3", Float) = 0
        [HideInInspector] _Playing4 ("Playing 4", Float) = 0
        [HideInInspector] _Playing5 ("Playing 5", Float) = 0
        [HideInInspector] _Playing6 ("Playing 6", Float) = 0
        [HideInInspector] _Playing7 ("Playing 7", Float) = 0
        [HideInInspector] _Playing8 ("Playing 8", Float) = 0
        [HideInInspector] _Playing9 ("Playing 9", Float) = 0
        [HideInInspector] _Playing10 ("Playing 10", Float) = 0
        [HideInInspector] _Playing11 ("Playing 11", Float) = 0
        [HideInInspector] _Playing12 ("Playing 12", Float) = 0
        [HideInInspector] _Playing13 ("Playing 13", Float) = 0
        [HideInInspector] _Playing14 ("Playing 14", Float) = 0
        [HideInInspector] _Pressed0 ("Pressed 0", Float) = 0
        [HideInInspector] _Pressed1 ("Pressed 1", Float) = 0
        [HideInInspector] _Pressed2 ("Pressed 2", Float) = 0
        [HideInInspector] _Pressed3 ("Pressed 3", Float) = 0
        [HideInInspector] _Pressed4 ("Pressed 4", Float) = 0
        [HideInInspector] _Pressed5 ("Pressed 5", Float) = 0
        [HideInInspector] _Pressed6 ("Pressed 6", Float) = 0
        [HideInInspector] _Pressed7 ("Pressed 7", Float) = 0
        [HideInInspector] _Pressed8 ("Pressed 8", Float) = 0
        [HideInInspector] _Pressed9 ("Pressed 9", Float) = 0
        [HideInInspector] _Pressed10 ("Pressed 10", Float) = 0
        [HideInInspector] _Pressed11 ("Pressed 11", Float) = 0
        [HideInInspector] _Pressed12 ("Pressed 12", Float) = 0
        [HideInInspector] _Pressed13 ("Pressed 13", Float) = 0
        [HideInInspector] _Pressed14 ("Pressed 14", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" "VRCFallback"="Unlit" }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"

            float4 _BodyColor, _KeyColor, _InactiveColor, _PlayingColor, _PressedColor, _DotColor, _DotLitColor;
            float _Page;
            float _Active0;
            float _Active1;
            float _Active2;
            float _Active3;
            float _Active4;
            float _Active5;
            float _Active6;
            float _Active7;
            float _Active8;
            float _Active9;
            float _Active10;
            float _Active11;
            float _Active12;
            float _Active13;
            float _Active14;
            float _Playing0;
            float _Playing1;
            float _Playing2;
            float _Playing3;
            float _Playing4;
            float _Playing5;
            float _Playing6;
            float _Playing7;
            float _Playing8;
            float _Playing9;
            float _Playing10;
            float _Playing11;
            float _Playing12;
            float _Playing13;
            float _Playing14;
            float _Pressed0;
            float _Pressed1;
            float _Pressed2;
            float _Pressed3;
            float _Pressed4;
            float _Pressed5;
            float _Pressed6;
            float _Pressed7;
            float _Pressed8;
            float _Pressed9;
            float _Pressed10;
            float _Pressed11;
            float _Pressed12;
            float _Pressed13;
            float _Pressed14;

            struct appdata
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                float2 uv : TEXCOORD0;
                float2 uvIndex : TEXCOORD1;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                nointerpolation float4 info : TEXCOORD1; // x kind (0 body, 1 key, 2 dot), y face, z/w unused
                nointerpolation float3 state : TEXCOORD2; // active, playing, pressed (keys) / lit (dots)
                float shade : TEXCOORD3;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            v2f vert (appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_OUTPUT(v2f, o);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                float3 n = UnityObjectToWorldNormal(v.normal);
                o.shade = 0.75 + 0.25 * saturate(n.y * 0.5 + 0.5);
                int idx = (int)round(v.uvIndex.x);
                float3 s = float3(0, 0, 0);
                float kind = 0;
                if (idx >= 100) { kind = 2; s.x = abs((idx - 100) - _Page) < 0.5 ? 1 : 0; }
                else if (idx >= 0)
                {
                    kind = 1;
                if (idx == 0) s = float3(_Active0, _Playing0, _Pressed0);
                if (idx == 1) s = float3(_Active1, _Playing1, _Pressed1);
                if (idx == 2) s = float3(_Active2, _Playing2, _Pressed2);
                if (idx == 3) s = float3(_Active3, _Playing3, _Pressed3);
                if (idx == 4) s = float3(_Active4, _Playing4, _Pressed4);
                if (idx == 5) s = float3(_Active5, _Playing5, _Pressed5);
                if (idx == 6) s = float3(_Active6, _Playing6, _Pressed6);
                if (idx == 7) s = float3(_Active7, _Playing7, _Pressed7);
                if (idx == 8) s = float3(_Active8, _Playing8, _Pressed8);
                if (idx == 9) s = float3(_Active9, _Playing9, _Pressed9);
                if (idx == 10) s = float3(_Active10, _Playing10, _Pressed10);
                if (idx == 11) s = float3(_Active11, _Playing11, _Pressed11);
                if (idx == 12) s = float3(_Active12, _Playing12, _Pressed12);
                if (idx == 13) s = float3(_Active13, _Playing13, _Pressed13);
                if (idx == 14) s = float3(_Active14, _Playing14, _Pressed14);
                }
                o.info = float4(kind, v.uvIndex.y, 0, 0);
                o.state = s;
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float3 c;
                if (i.info.x < 0.5) c = _BodyColor.rgb;
                else if (i.info.x > 1.5) c = lerp(_DotColor.rgb, _DotLitColor.rgb, i.state.x);
                else
                {
                    float active = saturate(i.state.x), playing = saturate(i.state.y), pressed = saturate(i.state.z);
                    c = lerp(_InactiveColor.rgb, _KeyColor.rgb, active);
                    // soft rounded-square inset on the key face
                    float2 q = abs(i.uv - 0.5);
                    float edge = smoothstep(0.40, 0.48, max(q.x, q.y));
                    float glow = 1 - smoothstep(0.0, 0.5, length(i.uv - 0.5));
                    c = lerp(c, _PlayingColor.rgb * (0.6 + 0.6 * glow), playing * active);
                    c = lerp(c, _PressedColor.rgb, pressed * 0.7);
                    if (i.info.y > 0.5) c = lerp(c, c * 0.55, edge);
                    else c *= 0.5; // key sides
                }
                return fixed4(c * i.shade, 1);
            }
            ENDCG
        }
    }
    FallBack "Unlit/Color"
}
