#!/bin/sh
# Compila el APK sin Gradle: sh android/build.sh  ->  android/build/MiBiblioteca.apk
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-34/android.jar"
export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Eclipse Adoptium/jdk-17.0.14.7-hotspot}"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

"$BT/aapt2" compile --dir res -o "$OUT/res"
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o "$OUT/base.apk" --java "$OUT/gen" "$OUT"/res/*.flat
"$JAVA_HOME/bin/javac" -source 8 -target 8 -bootclasspath "$JAR" -nowarn -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
"$BT/d8.bat" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && "$JAVA_HOME/bin/jar" uf ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# Clave de firma propia (guárdala: las actualizaciones deben ir firmadas con la misma).
[ -f release.jks ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore release.jks -alias app -keyalg RSA -keysize 2048 \
  -validity 10000 -storepass biblioteca -keypass biblioteca -dname "CN=Mi biblioteca"
"$BT/apksigner.bat" sign --ks release.jks --ks-pass pass:biblioteca --key-pass pass:biblioteca \
  --out "$OUT/MiBiblioteca.apk" "$OUT/aligned.apk"
"$BT/apksigner.bat" verify "$OUT/MiBiblioteca.apk" && echo "APK listo: android/$OUT/MiBiblioteca.apk"
