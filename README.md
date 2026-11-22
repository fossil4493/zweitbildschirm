# Tablet-Zweitbildschirm

GNOME-Erweiterung: ein Tablet (oder jedes andere Gerät mit RDP-App) als **erweiterter
Bildschirm** für einen Linux-Rechner mit GNOME auf Wayland. Grundlage ist GNOME Remote
Desktop im Modus „Bildschirm erweitern“.

## Funktionen

**Grundfunktion** – ohne root, ohne Entwickleroptionen am Tablet:

- Schalter „Tablet-Bildschirm“ in den Schnelleinstellungen startet GNOME Remote Desktop
  im Erweiterungsmodus (eigenes TLS-Zertifikat, Anmeldung mit Benutzer und Passwort).
- Das Tablet verbindet sich mit einer RDP-App mit einer der angezeigten Adressen, per
  WLAN oder per Kabel über USB-Tethering.
- Anordnung und Skalierung aller Bildschirme werden je Monitor-Kombination gemerkt
  (GNOME selbst vergisst sie, weil der virtuelle Monitor bei jeder Verbindung neu ist).
- Nach einem Verbindungsabbruch kommen alle Fenster wieder an ihre Stelle aufs Tablet.
- Ausgabegerät „Tablet“: der Ton geht nur ans Tablet, wenn es als Ausgabe gewählt ist.

**Optional, in den Einstellungen der Erweiterung:**

- **Firewall-Helfer** (`sudo make install`): öffnet Port 3389 nur für freigegebene
  Geräte (MAC-Adresse) und nur, solange der Tablet-Bildschirm an ist.
- **Android-Automatik über adb** (Entwickleroptionen am Tablet): Tablet erkennen, App
  öffnen und automatisch verbinden; per Kabel durch einen adb-Tunnel (kein offener Port),
  per WLAN direkt, mit automatischem Wechsel zwischen Kabel und WLAN. Auf Wunsch sperrt
  sich das Tablet mit dem Laptop und wacht beim Entsperren des Laptops wieder auf.

## Voraussetzungen

- GNOME Shell 49–51 auf Wayland
- `gnome-remote-desktop`, `openssl`, `iproute2`; für die Tonausgabe PipeWire mit
  `pactl`, `pw-dump`, `pw-link`
- optional: `firewalld` (Helfer), `android-tools` (adb)
- am Tablet eine RDP-App. Empfohlen: Vento mit echtem Touch (siehe `vento/`); jede andere
  RDP-App geht auch, dann aber ohne Multitouch-Eingabe.

## Installation

```sh
make install-extension          # Erweiterung für den aktuellen Benutzer
gnome-extensions enable zweitbildschirm@fossil4493.github.io
sudo make install               # optional: Firewall-Helfer (PREFIX=/usr/local)
```

Unter Wayland lädt GNOME neue Erweiterungen erst nach dem nächsten Anmelden.

Danach: Einstellungen → Erweiterungen → Tablet-Zweitbildschirm → Benutzer und Passwort
festlegen, Schalter in den Schnelleinstellungen einschalten, am Tablet mit der angezeigten
Adresse verbinden.

Entfernen: `make uninstall-extension`, `sudo make uninstall`.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `extension/` | die GNOME-Erweiterung (`lib/`: RDP, Anordnung, Fenster, Ton, Firewall, adb) |
| `system/` | Firewall-Helfer und polkit-Aktionen für `make install` |
| `vento/` | Bau der Tablet-App Vento mit Direct Touch und Ton (`VENTO_REPO=<git-url> vento/bauen.sh`, Branch `touch-pr23`) |
| `extras/terminal/` | foot- und tmux-Konfiguration für Touch-Bedienung im Terminal |

## Sicherheit

- Ohne Helfer öffnet die Erweiterung keine Ports. Ohne Freigabe in der Firewall ist der
  Rechner nur über den adb-Tunnel (Kabel) erreichbar.
- Der Helfer öffnet 3389 nur zur Laufzeit und nur für MAC-Adressen in
  `/etc/zweitbildschirm/erlaubte-macs` – und nur in dem Netz, in dem das Gerät freigegeben
  wurde (erkannt an der MAC-Adresse des Routers). In fremden WLANs bleibt der Port zu. Neue Geräte trägt nur `zweitbildschirm-freigabe`
  ein, und das verlangt immer das Admin-Passwort.
- Die Verbindung ist TLS-verschlüsselt (Zertifikat-Fingerabdruck in den Einstellungen)
  und verlangt Benutzer und Passwort (im GNOME-Schlüsselbund).
