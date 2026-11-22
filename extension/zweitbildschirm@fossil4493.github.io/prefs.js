import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as rdp from './lib/rdp.js';
import * as firewall from './lib/firewall.js';
import {clearStore} from './lib/layout.js';
import {findProgram, localAddresses} from './lib/util.js';

function randomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 16; i++)
        s += chars[GLib.random_int_range(0, chars.length)];
    return s;
}

function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, subtitle, entries) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(entries.map(e => e[1]))});
    const sync = () => {
        const i = entries.findIndex(e => e[0] === settings.get_string(key));
        row.selected = i < 0 ? 0 : i;
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => settings.set_string(key, entries[row.selected][0]));
    return row;
}

function button(label, css = null) {
    return new Gtk.Button({label, valign: Gtk.Align.CENTER, cssClasses: css ? [css] : []});
}

export default class ZweitbildschirmPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 860);
        const toast = title => window.add_toast(new Adw.Toast({title, timeout: 5}));

        // =================================================================== Grundfunktion
        const page = new Adw.PreferencesPage({title: 'Allgemein', iconName: 'input-tablet-symbolic'});
        window.add(page);

        const start = new Adw.PreferencesGroup({
            title: 'So geht’s',
            description: '1. Benutzer und Passwort festlegen.\n' +
                '2. In den Schnelleinstellungen „Tablet-Bildschirm“ einschalten.\n' +
                '3. Am Tablet in einer RDP-App (z. B. Vento oder Microsoft Remote Desktop) eine Verbindung zu einer der Adressen unten anlegen.\n' +
                'Per Kabel ohne Entwickleroptionen: am Tablet „USB-Tethering“ einschalten und die Adresse der USB-Verbindung nehmen.',
        });
        page.add(start);
        const addr = new Adw.ActionRow({title: 'Adressen dieses Rechners', subtitle: '…', subtitleSelectable: true});
        start.add(addr);
        localAddresses().then(list => {
            addr.subtitle = list.length ? list.map(a => `${a.ip}:${rdp.PORT}  (${a.dev})`).join('\n') : 'kein Netzwerk';
        });
        if (!rdp.available()) {
            start.add(new Adw.ActionRow({
                title: 'GNOME Remote Desktop fehlt',
                subtitle: 'Paket „gnome-remote-desktop“ installieren',
            }));
        }

        // ---- Zugang
        const access = new Adw.PreferencesGroup({
            title: 'Zugang',
            description: 'Anmeldung am Tablet. Das Passwort liegt nur im GNOME-Schlüsselbund.',
        });
        page.add(access);
        const user = new Adw.EntryRow({title: 'Benutzer'});
        access.add(user);
        const pw = new Adw.PasswordEntryRow({title: 'Neues Passwort'});
        access.add(pw);
        const pwRow = new Adw.ActionRow({title: 'Zugang speichern'});
        const gen = button('Zufälliges Passwort');
        const save = button('Speichern', 'suggested-action');
        gen.connect('clicked', () => {
            pw.text = randomPassword();
        });
        save.connect('clicked', async () => {
            const u = user.text.trim();
            if (!u || pw.text.length < 8) {
                toast('Benutzer angeben, Passwort mindestens 8 Zeichen');
                return;
            }
            const r = await rdp.setCredentials(u, pw.text);
            toast(r.ok ? 'Gespeichert – in der App am Tablet genauso eintragen' : `Fehler: ${r.err || r.out}`);
            pw.text = '';
            refreshStatus();
        });
        pwRow.add_suffix(gen);
        pwRow.add_suffix(save);
        access.add(pwRow);
        const fp = new Adw.ActionRow({
            title: 'Zertifikat (SHA-256)',
            subtitle: '…',
            subtitleSelectable: true,
        });
        access.add(fp);
        const refreshStatus = () => rdp.status().then(st => {
            user.text = st.user || user.text;
            pwRow.subtitle = st.user && st.hasPassword ? `eingerichtet für „${st.user}“` : 'noch nicht eingerichtet';
            fp.subtitle = st.fingerprint && st.fingerprint !== '(null)'
                ? `${st.fingerprint}\nDie App am Tablet zeigt diesen Fingerabdruck beim ersten Verbinden.`
                : 'wird beim ersten Einschalten erzeugt';
        });
        refreshStatus();

        // ---- Verhalten
        const behave = new Adw.PreferencesGroup({title: 'Verhalten'});
        page.add(behave);
        behave.add(switchRow(settings, 'tablet-sound', 'Tonausgabe „Tablet“',
            'Solange ein Gerät verbunden ist, gibt es das Ausgabegerät „Tablet“. Die App am Tablet muss Ton empfangen (Vento: „Sound: This phone“).'));
        behave.add(switchRow(settings, 'restore-windows', 'Fenster zurückholen',
            'Nach einem Verbindungsabbruch kommen alle Fenster wieder an ihre Stelle auf dem Tablet.'));
        behave.add(switchRow(settings, 'remember-layout', 'Anordnung merken',
            'Lage und Skalierung aller Bildschirme, getrennt je Kombination von Monitoren. Ändern einfach in Einstellungen → Bildschirme, während das Tablet verbunden ist.'));
        const clear = new Adw.ActionRow({title: 'Gespeicherte Anordnungen'});
        const clearBtn = button('Löschen', 'destructive-action');
        clearBtn.connect('clicked', () => toast(clearStore() ? 'Gelöscht' : 'Nichts gespeichert'));
        clear.add_suffix(clearBtn);
        behave.add(clear);
        behave.add(switchRow(settings, 'animate-transitions', 'Weicher Übergang',
            'Beim Verbinden und Trennen werden die Bildschirme kurz abgedunkelt (mit Ladekreis), bis alles wieder an seinem Platz ist.'));
        behave.add(switchRow(settings, 'notifications', 'Hinweise anzeigen'));

        // =================================================================== Firewall
        const fwPage = new Adw.PreferencesPage({title: 'Firewall', iconName: 'security-high-symbolic'});
        window.add(fwPage);
        const fwInfo = new Adw.PreferencesGroup({
            title: 'Netzwerkzugang',
            description: 'Das Tablet verbindet sich auf Port 3389 mit diesem Rechner. Ist eine Firewall aktiv (z. B. firewalld bei openSUSE und Fedora), muss sie das durchlassen.\n\n' +
                'Ohne Helfer, nur bis zum Neustart der Firewall:\n    sudo firewall-cmd --add-port=3389/tcp\n\n' +
                'Mit Helfer (empfohlen): Port nur für freigegebene Geräte und nur, solange der Tablet-Bildschirm an ist. Installation aus dem Quellordner: sudo make install',
        });
        fwPage.add(fwInfo);
        const fwGroup = new Adw.PreferencesGroup({title: 'Firewall-Helfer'});
        fwPage.add(fwGroup);
        const helperRow = new Adw.ActionRow({
            title: 'Helfer',
            subtitle: firewall.installed() ? 'installiert' : 'nicht installiert (sudo make install)',
        });
        fwGroup.add(helperRow);
        const auto = switchRow(settings, 'firewall-auto', 'Port automatisch öffnen',
            'Nur für freigegebene Geräte (MAC-Adresse), nur in dem Netz, in dem sie freigegeben wurden, nur zur Laufzeit.');
        auto.sensitive = firewall.installed();
        fwGroup.add(auto);
        const macs = new Adw.ActionRow({title: 'In diesem Netz freigegebene Geräte', subtitle: '…', subtitleSelectable: true});
        fwGroup.add(macs);
        const refreshMacs = () => {
            if (!firewall.installed()) {
                macs.subtitle = '–';
                return;
            }
            firewall.allowedMacs().then(l => {
                macs.subtitle = l.length ? l.join('\n') : 'keine';
            });
        };
        refreshMacs();
        const ip = new Adw.EntryRow({title: 'IP-Adresse des Tablets (steht am Tablet unter WLAN → Netzwerkdetails)'});
        const approveBtn = button('Freigeben');
        approveBtn.sensitive = firewall.installed();
        approveBtn.connect('clicked', async () => {
            const r = await firewall.approve(ip.text.trim());
            toast(r.ok ? 'Freigegeben' : `Nicht freigegeben: ${(r.err || r.out).trim()}`);
            refreshMacs();
        });
        ip.add_suffix(approveBtn);
        fwGroup.add(ip);
        fwGroup.add(new Adw.ActionRow({
            title: 'Hinweis',
            subtitle: 'Eine Freigabe gilt nur in dem Netz, in dem sie erteilt wurde (erkannt am Router). In einem neuen Netz, etwa einem öffentlichen WLAN, bleibt der Port zu, bis das Tablet dort ausdrücklich freigegeben wird. Am sichersten ist unterwegs das Kabel.',
        }));

        // =================================================================== Android-Automatik
        const aPage = new Adw.PreferencesPage({title: 'Android-Automatik', iconName: 'phone-symbolic'});
        window.add(aPage);
        const adbFound = !!findProgram('adb', [settings.get_string('adb-path'),
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'adb'])]);
        const aInfo = new Adw.PreferencesGroup({
            title: 'Automatik über adb (optional)',
            description: 'Erkennt das Tablet, öffnet die App und verbindet von selbst – per Kabel ohne Netzwerk und ohne offenen Port, per WLAN mit automatischem Wechsel.\n\n' +
                'Voraussetzungen:\n' +
                '• Paket „android-tools“ (adb)\n' +
                '• am Tablet: Einstellungen → Telefoninfo → Softwareinformationen → 7× auf „Buildnummer“, dann Entwickleroptionen → „USB-Debugging“ an\n' +
                '• für WLAN zusätzlich „Kabelloses Debugging“ an, einmal koppeln (adb pair), und den Firewall-Helfer\n' +
                '• automatisch verbinden: Vento (Debug-Variante) mit einer Verbindung zu 127.0.0.1:3389',
        });
        aPage.add(aInfo);
        const aGroup = new Adw.PreferencesGroup();
        aPage.add(aGroup);
        const adbOn = switchRow(settings, 'adb-enabled', 'Android-Automatik',
            adbFound ? 'adb gefunden' : 'adb nicht gefunden – „android-tools“ installieren oder Pfad angeben');
        aGroup.add(adbOn);
        const adbPath = new Adw.EntryRow({title: 'Pfad zu adb (leer = suchen)', showApplyButton: true});
        settings.bind('adb-path', adbPath, 'text', Gio.SettingsBindFlags.DEFAULT);
        aGroup.add(adbPath);
        const serial = new Adw.EntryRow({title: 'Seriennummer des Tablets (leer = erstes Gerät)', showApplyButton: true});
        settings.bind('tablet-serial', serial, 'text', Gio.SettingsBindFlags.DEFAULT);
        aGroup.add(serial);
        aGroup.add(comboRow(settings, 'tablet-app', 'App auf dem Tablet', null, [
            ['vento', 'Vento'], ['microsoft', 'Microsoft Remote Desktop'], ['none', 'Keine öffnen'],
        ]));
        aGroup.add(switchRow(settings, 'auto-connect', 'Automatisch verbinden', 'Nur mit Vento'));
        aGroup.add(switchRow(settings, 'wlan-enabled', 'WLAN nutzen, wenn kein Kabel steckt',
            'Braucht kabelloses Debugging und den Firewall-Helfer'));
        aGroup.add(switchRow(settings, 'lock-tablet', 'Tablet mitsperren',
            'Sperrt der Laptop, geht der Bildschirm des Tablets aus und das Tablet ist gesperrt. Nur per Kabel oder kabellosem Debugging'));
        aGroup.add(switchRow(settings, 'wake-tablet', 'Tablet beim Entsperren aufwecken',
            'Entsperrt der Laptop, geht der Bildschirm des Tablets an; entsperrt wird am Tablet (Fingerabdruck, Gesicht, PIN)'));
        aGroup.add(comboRow(settings, 'cable-while-wlan', 'Kabel angesteckt während einer WLAN-Sitzung', null, [
            ['switch', 'Auf Kabel wechseln (kurze Unterbrechung)'], ['keep', 'WLAN-Sitzung behalten'],
        ]));
        for (const w of [adbPath, serial])
            settings.bind('adb-enabled', w, 'sensitive', Gio.SettingsBindFlags.GET);
    }
}
