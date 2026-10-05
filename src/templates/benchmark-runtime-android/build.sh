set -eu
task_build="$SC_RUNTIME_ROOT/build"
task_tools="$SC_ANDROID_SDK/build-tools/$SC_BUILD_TOOLS"
task_platform="$SC_ANDROID_SDK/platforms/android-$SC_API/android.jar"
mkdir -p "$task_build/classes"
"$task_tools/aapt2" link -I "$task_platform" --manifest AndroidManifest.xml --min-sdk-version 26 --target-sdk-version 35 -o "$task_build/base.apk"
javac -source 8 -target 8 -classpath "$task_platform" -d "$task_build/classes" MainActivity.java
"$task_tools/d8" --lib "$task_platform" --output "$task_build" "$task_build"/classes/io/sandcastle/fixture/*.class
zip -j "$task_build/base.apk" "$task_build/classes.dex"
keytool -genkeypair -keystore "$task_build/debug.keystore" -storepass android -keypass android -alias fixture -keyalg RSA -keysize 2048 -validity 30 -dname 'CN=Disposable Sandcastle Fixture' >/dev/null 2>&1
"$task_tools/apksigner" sign --ks "$task_build/debug.keystore" --ks-pass pass:android --out "$task_build/candidate.apk" "$task_build/base.apk"
