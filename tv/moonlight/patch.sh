#!/bin/sh
# Builds moonlight-tv.apk: Moonlight for Android v12.2 with two changes for a TV remote that is a keyboard-class device
# (the Xiaomi RC: sources 0x301, not a gamepad), where stock Moonlight drops OK (DPAD_CENTER has no key mapping) and
# quits the stream on Back:
#   1. KeyboardTranslator.translate: DPAD_CENTER (23) → Enter, BACK (4) → Escape on the host.
#   2. Defaults for this TV, whose Wi-Fi takes only ~9 Mbit/s from omarchy (TCP, 2026-09-30): resolution $RES (not
#      1280x720) and codec $CODEC (not auto, which picks H.264 on the TV's MStar decoder: HEVC needs ~40 % less).
# Needs apktool, Java and Android build-tools. Signed with the debug key: `adb install -r` over an earlier build keeps
# the pairing but not new defaults (Moonlight saved the old ones on first start: `adb shell pm clear com.limelight`
# and pair again); over Play Store Moonlight it must be uninstalled first (different key).
set -e
cd "$(dirname "$0")"
V=v12.2
RES=${RES:-1920x1080} # 3840x2160 on a link that carries ~40 Mbit/s
CODEC=${CODEC:-forceh265} # auto | neverh265 (H.264) | forceh265 | forceav1
BT="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/build-tools/35.0.0"
rm -rf build && mkdir build
curl -sfL -o build/moonlight.apk "https://github.com/moonlight-stream/moonlight-android/releases/download/$V/app-nonRoot-release.apk"
apktool d -q -f -o build/src build/moonlight.apk
python3 - build/src "$RES" "$CODEC" <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]) / 'smali/com/limelight'
res, codec = sys.argv[2], sys.argv[3]
def patch(rel, old, new, count):
    p = src / rel
    s = p.read_text()
    assert s.count(old) == count, (rel, s.count(old))
    p.write_text(s.replace(old, new))
head = '.method public final translate(II)S\n    .locals 3\n'
patch('binding/input/KeyboardTranslator.smali', head, head + '''
    # TV remote: OK (DPAD_CENTER) is Enter and Back is Escape on the host; (short) 0x8000 | VK.
    const/16 v0, 0x17
    if-ne p1, v0, :tv_not_ok
    const/16 v0, -0x7ff3
    return v0
    :tv_not_ok
    const/4 v0, 0x4
    if-ne p1, v0, :tv_not_back
    const/16 v0, -0x7fe5
    return v0
    :tv_not_back
''', 1)
# DEFAULT_RESOLUTION, inlined where it is read (and where Settings falls back to it).
for rel in ('preferences/PreferenceConfiguration.smali', 'preferences/StreamSettings$SettingsFragment.smali',
            'preferences/StreamSettings$SettingsFragment$3.smali', 'preferences/SeekBarPreference.smali'):
    p = src / rel
    s = p.read_text()
    assert s.count('"1280x720"') == 1, rel
    p.write_text(s.replace('"1280x720"', f'"{res}"'))
# Settings' XML defaults too: Moonlight writes them into its preferences on first start (PcView setDefaultValues), and
# from then on those win over the code's.
import re
x = pathlib.Path(sys.argv[1]) / 'res/xml/preferences.xml'
t = x.read_text()
for key, value in (('list_resolution', res), ('video_format', codec)):
    t, n = re.subn(r'(<ListPreference [^>]*android:key="%s"[^>]*android:defaultValue=")[^"]*(")' % key, r'\g<1>%s\g<2>' % value, t)
    assert n == 1, key
x.write_text(t)
# DEFAULT_VIDEO_FORMAT, inlined where it is read. Its register v6 then serves the first comparison (== "auto") too,
# so the default gets a register of its own (v7, set again only after) or "forceh265" would read as auto.
p = src / 'preferences/PreferenceConfiguration.smali'
t, n = re.subn(r'(const-string v5, "video_format"(?:\s+\.line \d+)*\s+const-string v6, "auto")((?:\s+\.line \d+)*\s+)invoke-interface \{v4, v5, v6\}',
               r'\g<1>\n    const-string v7, "%s"\g<2>invoke-interface {v4, v5, v7}' % codec, p.read_text())
assert n == 1, 'video_format default'
p.write_text(t)
PY
apktool b -q -o build/unsigned.apk build/src
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --out moonlight-tv.apk build/aligned.apk 2>/dev/null
echo "built $(pwd)/moonlight-tv.apk"
