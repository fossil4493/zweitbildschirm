# Zweitbildschirm

GNOME-Erweiterung: ein Tablet (oder jedes andere Gerät mit RDP-App) als **erweiterter
Bildschirm** für einen Linux-Rechner mit GNOME auf Wayland. Grundlage ist GNOME Remote
Desktop im Modus „Bildschirm erweitern“.

## Funktionen

**Grundfunktion** – ohne root, ohne Entwickleroptionen am Tablet:

- Schalter „Zweitbildschirm“ in den Schnelleinstellungen startet GNOME Remote Desktop
  im Erweiterungsmodus (eigenes TLS-Zertifikat, Anmeldung mit Benutzer und Passwort).
- Das Tablet verbindet sich mit einer RDP-App mit einer der angezeigten Adressen, per
  WLAN oder per Kabel über USB-Tethering.
- Anordnung und Skalierung aller Bildschirme werden je Monitor-Kombination gemerkt
  (GNOME selbst vergisst sie, weil der virtuelle Monitor bei jeder Verbindung neu ist).
- Nach einem Verbindungsabbruch kommen alle Fenster wieder an ihre Stelle aufs Tablet.
- Ausgabegerät „Tablet“: der Ton geht nur ans Tablet, wenn es als Ausgabe gewählt ist.

**Optional, in den Einstellungen der Erweiterung:**

- **Firewall-Helfer** (`sudo make install`): öffnet Port 3389 nur für freigegebene
  Geräte (MAC-Adresse) und nur, solange der Zweitbildschirm an ist.
- **Android-Automatik über adb** (Entwickleroptionen am Tablet): Tablet erkennen, App
  öffnen und automatisch verbinden; per Kabel durch einen adb-Tunnel (kein offener Port),
  per WLAN direkt, mit automatischem Wechsel zwischen Kabel und WLAN. Auf Wunsch sperrt
  sich das Tablet mit dem Laptop und wacht beim Entsperren des Laptops wieder auf.

## Voraussetzungen

- GNOME Shell 49–51 auf Wayland
- `gnome-remote-desktop`, `openssl`, `iproute2`; für die Tonausgabe PipeWire mit
  `pactl`, `pw-dump`, `pw-link`, `pw-cli`
- zum Bauen: `make`, `python3`, `glib-compile-schemas`
- optional: `firewalld` (der Helfer arbeitet nur mit firewalld, nicht mit ufw oder
  reinem nftables), `android-tools` (adb)
- für die Android-Automatik über WLAN: Die Firewall muss im Heimnetz mDNS (UDP 5353)
  durchlassen, sonst findet adb das Tablet nicht. Bei firewalld am besten das Heim-WLAN
  in die Zone `home` legen, dort ist mDNS erlaubt:
  `nmcli connection modify "<WLAN-Name>" connection.zone home`
- am Tablet eine RDP-App. Empfohlen: Vento mit echtem Touch (siehe `vento/`); jede andere
  RDP-App geht auch, dann aber ohne Multitouch-Eingabe.

## Installation

```sh
make install-extension          # Erweiterung für den aktuellen Benutzer
gnome-extensions enable zweitbildschirm@fossil4493.github.io
sudo make install               # optional: Firewall-Helfer (PREFIX=/usr/local)
```

Der Helfer muss nach `/usr/local/libexec`, `/usr/libexec` oder `/usr/lib/zweitbildschirm`
(`PREFIX` bzw. `LIBEXECDIR`), dort sucht ihn die Erweiterung.

Unter Wayland lädt GNOME neue Erweiterungen erst nach dem nächsten Anmelden.

Danach: Einstellungen → Erweiterungen → Zweitbildschirm → Benutzer und Passwort
festlegen, Schalter in den Schnelleinstellungen einschalten, am Tablet mit der angezeigten
Adresse verbinden.

Entfernen: `make uninstall-extension`, `sudo make uninstall`.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `extension/` | die GNOME-Erweiterung (`lib/`: RDP, Anordnung, Fenster, Ton, Firewall, adb) |
| `system/` | Firewall-Helfer und polkit-Aktionen für `make install` |
| `vento/` | Bau der Tablet-App Vento mit Direct Touch und Ton (`vento/bauen.sh`, Branch `touch-pr23` von [fossil4493/vento](https://github.com/fossil4493/vento)) |
| `extras/terminal/` | foot- und tmux-Konfiguration für Touch-Bedienung im Terminal |

## Sicherheit

- Solange der Zweitbildschirm an ist, nimmt GNOME Remote Desktop auf Port 3389 in
  **allen** Netzen Verbindungen an, auch im Kabelbetrieb über den adb-Tunnel. Die
  Erweiterung öffnet selbst keinen Port, verlässt sich aber auf eine aktive Firewall: Ohne
  Firewall kann sich jeder im selben Netz an der Anmeldung versuchen. Mit firewalld und ohne
  Freigabe ist der Rechner nur über den adb-Tunnel (Kabel) erreichbar.
- Der Helfer öffnet 3389 nur zur Laufzeit und nur für MAC-Adressen in
  `/etc/zweitbildschirm/erlaubte-macs` – und nur in dem Netz, in dem das Gerät freigegeben
  wurde (erkannt an der MAC-Adresse des Routers). Wechselt der Rechner das Netz oder lädt
  firewalld neu, werden die Regeln neu gesetzt; in fremden WLANs bleibt der Port zu. Neue
  Geräte trägt nur `zweitbildschirm-freigabe` ein, und das verlangt immer das Admin-Passwort.
- Beim Einschalten übernimmt die Erweiterung die Einstellungen von GNOME Remote Desktop
  (Modus „erweitern“, Port 3389) und stellt die vorherigen beim Ausschalten wieder her.
- Die Verbindung ist TLS-verschlüsselt (Zertifikat-Fingerabdruck in den Einstellungen)
  und verlangt Benutzer und Passwort (im GNOME-Schlüsselbund).
