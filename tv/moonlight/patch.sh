#!/bin/sh
# Builds moonlight-tv.apk: Moonlight for Android v12.2 with two changes for a TV remote that is a keyboard-class device
# (the Xiaomi RC: sources 0x301, not a gamepad), where stock Moonlight drops OK (DPAD_CENTER has no key mapping) and
# quits the stream on Back:
#   1. KeyboardTranslator.translate: DPAD_CENTER (23) → Enter, BACK (4) → Escape on the host.
#   2. The default resolution 1280x720 → 3840x2160 (the TV panel; omarchy renders FlightHopper at 4K).
# Needs apktool, Java and Android build-tools. Signed with the debug key: `adb install -r` over an earlier build keeps
# the pairing; over Play Store Moonlight it must be uninstalled first (different key).
set -e
cd "$(dirname "$0")"
V=v12.2
BT="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/build-tools/35.0.0"
rm -rf build && mkdir build
curl -sfL -o build/moonlight.apk "https://github.com/moonlight-stream/moonlight-android/releases/download/$V/app-nonRoot-release.apk"
apktool d -q -f -o build/src build/moonlight.apk
python3 - build/src <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]) / 'smali/com/limelight'
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
    p.write_text(s.replace('"1280x720"', '"3840x2160"'))
PY
apktool b -q -o build/unsigned.apk build/src
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --out moonlight-tv.apk build/aligned.apk 2>/dev/null
echo "built $(pwd)/moonlight-tv.apk"
