set -eu
task_adb="$SC_ANDROID_SDK/platform-tools/adb"
"$task_adb" -P "$SC_ADB_PORT" -s "$SC_DEVICE_SERIAL" shell dumpsys activity activities | rg 'io.sandcastle.fixture/.MainActivity'
"$task_adb" -P "$SC_ADB_PORT" -s "$SC_DEVICE_SERIAL" shell uiautomator dump /sdcard/sandcastle-check.xml
"$task_adb" -P "$SC_ADB_PORT" -s "$SC_DEVICE_SERIAL" shell cat /sdcard/sandcastle-check.xml | rg 'Candidate ready'
