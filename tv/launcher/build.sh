#!/bin/sh
# Builds flighthopper-tv.apk without Gradle: aapt2 → javac → d8 → zip → sign.
# ponytail: debug-keystore signing, fine for sideloading; a Play upload would need a real key.
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-35/android.jar"
rm -rf build && mkdir -p build/classes build/gen

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o build/unsigned.apk --java build/gen build/res.zip
javac -Xlint:-options --release 8 -classpath "$JAR" -d build/classes $(find src build/gen -name '*.java')
"$BT/d8" --min-api 21 --lib "$JAR" --output build $(find build/classes -name '*.class')
(cd build && zip -qj unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk

KS="$HOME/.android/debug.keystore"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
  -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -validity 10000 >/dev/null
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --out flighthopper-tv.apk build/aligned.apk
echo "built $(pwd)/flighthopper-tv.apk"
