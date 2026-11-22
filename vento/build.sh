#!/bin/bash
# Läuft im Container (aufgerufen von bauen.sh): installiert SDK/NDK/Rust und baut die Debug-APK.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openjdk-21-jdk-headless curl unzip git ca-certificates clang libclang-dev ninja-build python3 build-essential m4 nasm perl pkg-config xz-utils file >/dev/null
export ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk
if [ ! -x $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager ]; then
  curl -fsSLo /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
  mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && unzip -q /tmp/clt.zip -d $ANDROID_SDK_ROOT/cmdline-tools && mv $ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest
fi
yes | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null || true
$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager 'ndk;28.2.13676358' 'build-tools;36.0.0' 'platforms;android-36' 'platform-tools' >/dev/null
export ANDROID_NDK_HOME=$ANDROID_SDK_ROOT/ndk/28.2.13676358
export CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:$PATH
[ -x /opt/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
cd /src
printf 'sdk.dir=%s\nndk.dir=%s\n' $ANDROID_SDK_ROOT $ANDROID_NDK_HOME > local.properties
rustup toolchain install
command -v cargo-ndk || cargo install cargo-ndk@4.1.2 --locked
[ -f .patched ] || { ./patch.sh -n && touch .patched; }
export GRADLE_USER_HOME=/opt/gradle
./gradlew --no-daemon :backends:fetchCryptoSources
./gradlew --no-daemon :app:assembleDebug
ls -la app/build/outputs/apk/debug/
