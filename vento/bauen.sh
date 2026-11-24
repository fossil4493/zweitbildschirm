#!/bin/bash
# Baut Vento mit "Direct touch" in einem Podman-Container und legt die APK als
# vento/vento-touch-pr23.apk ab. Quelle: Branch touch-pr23 von https://github.com/fossil4493/vento
# (upstream https://github.com/pgaskin/vento mit Pull-Request #23 und dem Ton-Patch), änderbar mit $VENTO_REPO.
# Platzbedarf während des Builds ca. 8 GB unter $VENTO_BUILD (Standard ~/.cache/vento-build),
# danach kann der Ordner gelöscht werden.
set -euo pipefail
HIER=$(cd "$(dirname "$0")" && pwd)
B=${VENTO_BUILD:-$HOME/.cache/vento-build}
mkdir -p "$B"/{sdk,cargo,rustup,gradle}
# Signierschlüssel dauerhaft aufheben: ein neuer Schlüssel erzwingt Deinstallieren (Verbindungen weg)
KEY=${VENTO_KEY:-$HOME/.config/vento-signatur}
mkdir -p "$KEY"
[ -d "$B/src" ] || git clone -b touch-pr23 "${VENTO_REPO:-https://github.com/fossil4493/vento.git}" "$B/src"
git -C "$B/src" submodule update --init --depth 1 --jobs 8
# setzt die Submodule auf den Stand ohne Vento-Patches zurück -> build.sh patcht neu
rm -f "$B/src/.patched"
# --network host: das Standardnetz von Podman (pasta) bricht bei vielen parallelen Downloads ab
podman run --rm --network host --name vento-build \
  -v "$B/src:/src:Z" -v "$HIER:/scripts:ro,Z" -v "$B/sdk:/opt/android-sdk:Z" \
  -v "$B/cargo:/opt/cargo:Z" -v "$B/rustup:/opt/rustup:Z" -v "$B/gradle:/opt/gradle:Z" -v "$KEY:/root/.android:Z" \
  docker.io/library/debian:trixie /scripts/build.sh
cp "$B/src/app/build/outputs/apk/debug/app-debug.apk" "$HIER/vento-touch-pr23.apk"
echo "Fertig: $HIER/vento-touch-pr23.apk  (installieren: adb -s <seriennr> install -r ...)"
