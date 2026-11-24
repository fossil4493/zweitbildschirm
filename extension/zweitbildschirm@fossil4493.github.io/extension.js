// Zweitbildschirm: ein Tablet (oder anderes Gerät mit RDP-App) als erweiterter Bildschirm.
//
// Grundfunktion (ohne root, ohne Entwickleroptionen): GNOME Remote Desktop im Modus
// „Bildschirm erweitern“, Anordnung merken, Fenster zurückholen, Tonausgabe „Tablet“.
// Optional: Firewall-Helfer (make install) und Android-Automatik über adb.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as rdp from './lib/rdp.js';
import * as sound from './lib/sound.js';
import * as firewall from './lib/firewall.js';
import {Adb, isUsb} from './lib/adb.js';
import {LayoutKeeper} from './lib/layout.js';
import {TabletWindows} from './lib/windows.js';
import {Transition} from './lib/transition.js';
import {run, localAddresses} from './lib/util.js';

const ICON = 'input-tablet-symbolic';
const TICK_MS = 2000;

// ---------------------------------------------------------------------------- Steuerung

class Controller {
    constructor(ext, settings, onChange) {
        this._ext = ext;
        this._settings = settings;
        this._onChange = onChange;
        this._adb = new Adb(settings);
        this._running = false;      // RDP-Server läuft
        this._firewallOpen = false;
        this._mode = null;          // adb: 'usb' | 'wlan'
        this._transport = null;
        this._lastWifi = 0;
        this._tick = 0;
        this._busy = false;
        this._stepDone = Promise.resolve();
        this._destroyed = false;
        this._firewallFailed = 0;
        this._netSig = null;
        this._allowed = null;
        this._noted = new Set();
        this.status = {text: 'Aus', peers: [], addresses: [], approveIp: null};
        // GNOME beendet Bildschirmfreigaben beim Sperren; nach dem Entsperren neu verbinden
        this._wasLocked = Main.sessionMode.isLocked;
        this._reconnect = false;
        this._modeId = Main.sessionMode.connect('updated', () => {
            const locked = Main.sessionMode.isLocked;
            if (this._wasLocked && !locked) {
                this._reconnect = true;
                if (this._settings.get_boolean('wake-tablet'))
                    this._tabletScreen('wake');
            } else if (!this._wasLocked && locked && this._settings.get_boolean('lock-tablet')) {
                this._tabletScreen('sleep');
            }
            this._wasLocked = locked;
        });
        this._reloadId = firewall.onReload(() => {
            this._firewallOpen = false;
        });
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._step();
            return GLib.SOURCE_CONTINUE;
        });
        this._step();
    }

    _set(patch) {
        Object.assign(this.status, patch);
        this._onChange();
    }

    /** Bildschirm des Tablets über adb aus- oder einschalten (nur mit Android-Automatik). Aus nur, wenn das
     *  Tablet gerade als Bildschirm läuft; an nur, wenn es so ausgeschaltet wurde. */
    _tabletScreen(action) {
        if (!this._settings.get_boolean('active') || !this._settings.get_boolean('adb-enabled') || !this._adb.path())
            return;
        (async () => {
            if (action === 'sleep') {
                if (!this._transport || !this.status.peers.length)
                    return;
                this._sleptSerial = this._adb.serialOf(this._transport);
                await this._adb.sleep(this._transport);
                return;
            }
            const serial = this._sleptSerial;
            this._sleptSerial = null;
            if (!serial)
                return;
            let t = await this._adb.transportOf(serial);
            if (!t) {
                // adb über WLAN kann im Schlaf des Tablets abreißen
                await this._adb.connectWireless();
                t = await this._adb.transportOf(serial);
            }
            if (t)
                await this._adb.wake(t);
        })().catch(e => logError(e, 'Zweitbildschirm'));
    }

    _notifyOnce(key, title, body) {
        if (this._noted.has(key))
            return;
        this._noted.add(key);
        if (this._settings.get_boolean('notifications'))
            this._ext.notify(title, body);
    }

    _step() {
        if (this._busy || this._destroyed)
            return;
        this._busy = true;
        this._stepDone = this._stepAsync().catch(e => logError(e, 'Zweitbildschirm')).finally(() => {
            this._busy = false;
        });
    }

    async _stepAsync() {
        this._tick++;
        if (!this._settings.get_boolean('active')) {
            if (this._running)
                await this.shutdown();
            this._noted.clear();
            this._set({text: 'Aus', peers: [], approveIp: null});
            return;
        }
        if (!rdp.available()) {
            this._set({text: 'GNOME Remote Desktop fehlt'});
            return;
        }
        if (this._settings.get_boolean('adb-enabled') && this._adb.path())
            await this._stepAdb();
        else
            await this._stepBasic();

        if (this._running && this._mode !== 'usb')
            await this._syncFirewall();
        if (this._running) {
            const peers = await rdp.peers();
            this._set({peers});
            await this._sound(peers.length > 0);
        }
    }

    async _syncFirewall() {
        if (!this._settings.get_boolean('firewall-auto') || !firewall.installed())
            return;
        const sig = await firewall.networkSignature();
        if (this._netSig === null) {
            this._netSig = sig;
        } else if (sig !== this._netSig) {
            this._netSig = sig;
            this._allowed = null;
            this._firewallOpen = false;
            this._firewallFailed = 0;
        }
        if (!this._firewallOpen)
            await this._openFirewall();
    }

    /**
     * Tonausgabe „Tablet“ nur, solange ein Gerät verbunden ist. Ohne Verbindung (auch nach
     * 3 s Kulanz bei einem Wechsel) verschwindet sie, damit der Ton wieder aus dem Laptop kommt;
     * war sie gewählt, wird sie beim nächsten Verbinden wieder Standard.
     */
    async _sound(connected) {
        const want = connected && this._settings.get_boolean('tablet-sound') && sound.available();
        if (want) {
            this._soundGoneSince = 0;
            if (!this._soundLoaded) {
                await sound.load(this._tabletWasDefault);
                this._soundLoaded = true;
                this._relinkAt = [2, 5, 10];   // GNOME Remote Desktop legt seine Tonstreams verzögert an
                this._relinkTick = this._tick;
            }
            // pw-dump fragt den ganzen PipeWire-Graphen ab und blockiert PipeWire dabei kurz –
            // alle 2 s ließ das Bild und Ton stocken. Deshalb nur nach dem Verbinden und dann
            // alle 60 s nachsehen.
            const since = this._tick - this._relinkTick;
            if (this._relinkAt?.length && since >= this._relinkAt[0]) {
                this._relinkAt.shift();
                await sound.onlyTablet();
            } else if (since > 0 && since % 30 === 0) {
                await sound.onlyTablet();
            }
        } else if (this._soundLoaded) {
            this._soundGoneSince ||= Date.now();
            if (!connected && Date.now() - this._soundGoneSince < 3000)
                return;
            this._tabletWasDefault = await sound.isDefault();
            await sound.unload();
            this._soundLoaded = false;
        }
    }

    async _startServer() {
        if (this._running)
            return true;
        const st = await rdp.status();
        if (!st.user || !st.hasPassword) {
            this._set({text: 'Benutzer und Passwort fehlen'});
            this._notifyOnce('creds', 'Zweitbildschirm', 'Bitte zuerst Benutzer und Passwort in den Einstellungen festlegen.');
            return false;
        }
        if (!await rdp.ensureCertificate()) {
            this._set({text: 'Zertifikat fehlt (openssl?)'});
            return false;
        }
        await rdp.start();
        this._running = true;
        return true;
    }

    async _openFirewall() {
        if (!this._settings.get_boolean('firewall-auto') || !firewall.installed())
            return false;
        if (Date.now() - this._firewallFailed < 60000)
            return false;
        this._firewallTouched = true;
        const r = await firewall.open();
        this._firewallOpen = r.ok;
        this._firewallFailed = r.ok ? 0 : Date.now();
        if (!r.ok) {
            this._notifyOnce('firewall', 'Firewall-Helfer', r.status === 6
                ? 'firewalld läuft nicht. Der Helfer arbeitet nur mit firewalld.'
                : `Port konnte nicht geöffnet werden: ${(r.err || r.out).trim()}`);
        }
        return this._firewallOpen;
    }

    async _closeFirewall() {
        if (this._firewallTouched) {
            await firewall.close();
            this._firewallTouched = false;
            this._firewallOpen = false;
        }
    }

    // ---------------------------------------------------- Grundfunktion: Gerät verbindet sich selbst

    async _stepBasic() {
        this._reconnect = false;   // ohne adb kann nur die App am Tablet neu verbinden
        if (this._mode)
            await this._leaveAdb();
        if (!this._running && !await this._startServer())
            return;
        if (this._tick % 10 === 1)
            this._set({addresses: await localAddresses()});
        const p = this.status.peers;
        this._set({text: p.length ? `Verbunden (${p.join(', ')})` : 'Bereit – Gerät verbinden'});
    }

    // ---------------------------------------------------- Android-Automatik über adb

    async _desired(ts) {
        const usb = ts.filter(isUsb), wifi = ts.filter(t => !isUsb(t));
        if (usb.length) {
            // läuft gerade eine Sitzung über das Netz und soll sie bleiben?
            const direct = (await rdp.peers()).some(p => p !== '127.0.0.1');
            if (direct && this._settings.get_string('cable-while-wlan') === 'keep')
                return this._mode === 'wlan' ? ['wlan', this._transport] : null;
            return ['usb', usb[0]];
        }
        if (wifi.length && this._settings.get_boolean('wlan-enabled') &&
            this._settings.get_boolean('firewall-auto') && firewall.installed())
            return ['wlan', wifi[0]];
        return null;
    }

    async _stepAdb() {
        const ts = await this._adb.transports();
        const want = await this._desired(ts);
        const now = Date.now() / 1000;

        if (this._settings.get_boolean('wlan-enabled') && !ts.some(t => !isUsb(t)) && now - this._lastWifi > 15) {
            this._lastWifi = now;
            this._adb.connectWireless();   // Steuerverbindung über WLAN bereithalten
        }

        if (!want) {
            // Tablet per adb nicht erreichbar: wie die Grundfunktion weiterlaufen, damit sich das
            // Tablet selbst verbinden kann (z. B. Vento „… (WLAN)“, wenn kabelloses Debugging aus ist)
            await this._stepBasic();
            if (!this.status.peers.length)
                this._set({text: ts.length ? 'Bereit – Tablet per WLAN nicht freigeschaltet' : 'Bereit – Tablet selbst verbinden'});
            return;
        }
        if (!this._running && !await this._startServer())
            return;
        const [mode, t] = want;
        if (mode !== this._mode || t !== this._transport) {
            await this._use(mode, t);
        } else if (this._reconnect) {
            this._reconnect = false;
            if (!(await rdp.peers()).length)
                await this._reopen(mode, t);
        } else if (mode === 'usb' && this._tick % 5 === 0 && !await this._adb.hasReverse(t)) {
            await this._adb.reverse(t);
        }
    }

    async _use(mode, t) {
        const switching = this._mode !== null;
        const peers = await rdp.peers();
        // neu starten, wenn keine Sitzung läuft (altes Fenster) oder sie über den anderen Weg läuft
        const fresh = switching || !peers.length || (mode === 'usb' && peers.some(p => p !== '127.0.0.1'));
        if (mode === 'usb') {
            await this._closeFirewall();
            await this._adb.reverse(t);
            this._mode = 'usb';
            this._transport = t;
            this._set({text: 'Verbunden per Kabel', approveIp: null});
            if (switching)
                this._ext.notify('Zweitbildschirm', 'Tablet jetzt per Kabel verbunden.', true);
            if (peers.length && peers.every(p => p === '127.0.0.1'))
                return;   // läuft schon über den Tunnel
            await this._adb.openApp(t, await this._usbConnection(t), {fresh});
            return;
        }
        // WLAN: direkte Verbindung, Firewall nur für das freigegebene Tablet
        const ip = await this._adb.ipOf(t);
        if (!ip) {
            this._set({text: 'WLAN: Adresse des Tablets unbekannt'});
            return;
        }
        const mac = await firewall.macOf(ip);
        this._allowed ??= await firewall.allowedMacs();
        if (!mac || !this._allowed.includes(mac)) {
            this._set({text: 'WLAN: Tablet freigeben', approveIp: ip});
            this._notifyOnce(`approve-${mac}`, 'Tablet in neuem WLAN',
                'Im Schnellmenü „Zweitbildschirm“ → „Tablet freigeben“ antippen (Admin-Passwort).');
            return;
        }
        if (this._mode === 'usb')
            await this._adb.unreverse(this._transport);
        if (!await this._openFirewall()) {
            this._set({text: 'WLAN: Firewall-Helfer fehlgeschlagen'});
            return;
        }
        const route = await run(['ip', '-o', 'route', 'get', ip]);
        const laptopIp = route.out.match(/\bsrc\s+([\d.]+)/)?.[1];
        this._mode = 'wlan';
        this._transport = t;
        this._set({text: 'Verbunden über WLAN', approveIp: null});
        if (switching)
            this._ext.notify('Zweitbildschirm', 'Tablet jetzt über WLAN verbunden.', true);
        // läuft schon eine direkte Sitzung von diesem Tablet (selbst verbunden), nicht stören
        if (peers.includes(ip))
            return;
        const fp = (await rdp.status()).fingerprint;
        const cid = laptopIp ? await this._adb.prepareWlan(t, laptopIp, fp) : null;
        await this._adb.openApp(t, cid, {fresh: true});
    }

    /** ID von Ventos Kabel-Verbindung; meldet einmal, wenn sie so eingestellt ist, dass die Anmeldung
     *  scheitert (Vento fragt dann nur immer wieder nach dem Passwort). */
    async _usbConnection(t) {
        const {id, problem} = await this._adb.usbConnection(t, (await rdp.status()).user);
        if (problem)
            this._notifyOnce(`vento-${problem}`, 'Vento falsch eingerichtet', problem);
        return id;
    }

    async _reopen(mode, t) {
        let cid;
        if (mode === 'usb') {
            cid = await this._usbConnection(t);
        } else {
            const ip = await this._adb.ipOf(t);
            const route = ip ? await run(['ip', '-o', 'route', 'get', ip]) : {out: ''};
            const laptopIp = route.out.match(/\bsrc\s+([\d.]+)/)?.[1];
            cid = laptopIp ? await this._adb.prepareWlan(t, laptopIp, (await rdp.status()).fingerprint) : null;
        }
        await this._adb.openApp(t, cid, {fresh: true});
    }

    async _leaveAdb() {
        if (this._mode === 'usb' && this._transport)
            await this._adb.unreverse(this._transport);
        this._mode = null;
        this._transport = null;
    }

    async approve(ip) {
        const r = await firewall.approve(ip);
        if (r.ok) {
            this._noted.clear();
            this._allowed = null;
        }
        this._step();
        return r;
    }

    async shutdown() {
        await this._leaveAdb();
        await this._closeFirewall();
        if (this._running) {
            await rdp.stop();
            if (this._soundLoaded) {
                this._tabletWasDefault = await sound.isDefault();
                await sound.unload();
                this._soundLoaded = false;
            }
        }
        this._running = false;
    }

    destroy() {
        this._destroyed = true;
        Main.sessionMode.disconnect(this._modeId);
        firewall.offReload(this._reloadId);
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._stepDone.then(() => this.shutdown()).catch(e => logError(e));
    }
}

// ---------------------------------------------------------------------------- Oberfläche

const TabletToggle = GObject.registerClass(
class TabletToggle extends QuickMenuToggle {
    _init(ext, settings) {
        super._init({title: 'Zweitbildschirm', iconName: ICON, toggleMode: false});
        this._ext = ext;
        this._settings = settings;
        this.menu.setHeader(ICON, 'Zweitbildschirm', '');
        this._info = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._info);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Einstellungen', () => ext.openPreferences());
        this.connect('clicked', () => settings.set_boolean('active', !settings.get_boolean('active')));
        this._settingsId = settings.connect('changed::active', () => this.update());
    }

    update() {
        const ctl = this._ext.controller;
        const st = ctl?.status ?? {text: 'Aus', peers: [], addresses: []};
        this.checked = this._settings.get_boolean('active');
        this.subtitle = st.text;
        this.menu.setHeader(ICON, 'Zweitbildschirm', st.text);
        this._info.removeAll();
        if (this.checked && !this._settings.get_boolean('adb-enabled')) {
            for (const a of st.addresses ?? [])
                this._info.addMenuItem(new PopupMenu.PopupMenuItem(`Adresse: ${a.ip}:${rdp.PORT}  (${a.dev})`, {reactive: false}));
        }
        if (st.approveIp) {
            this._info.addAction(`Tablet freigeben (${st.approveIp}) …`, async () => {
                const r = await ctl.approve(st.approveIp);
                if (!r.ok && r.status !== 126)
                    this._ext.notify('Tablet nicht freigegeben', (r.err || r.out).trim() || `Fehler ${r.status}`);
            });
        }
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        super.destroy();
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(ext, settings) {
        super._init();
        this._icon = this._addIndicator();
        this._icon.iconName = ICON;
        this._icon.visible = false;
        this.toggle = new TabletToggle(ext, settings);
        this.toggle.connect('destroy', () => {
            this.toggle = null;
        });
        this.quickSettingsItems.push(this.toggle);
        // auf dem Sperrbildschirm nichts anbieten (die Verbindung selbst läuft weiter)
        this._modeId = Main.sessionMode.connect('updated', () => this._syncLocked());
        this._syncLocked();
    }

    _syncLocked() {
        if (this.toggle)
            this.toggle.visible = !Main.sessionMode.isLocked;
    }

    update(peers) {
        if (!this.toggle)
            return;
        this._icon.visible = peers.length > 0;
        this.toggle.update();
    }

    destroy() {
        Main.sessionMode.disconnect(this._modeId);
        this.quickSettingsItems.forEach(i => i.destroy());
        super.destroy();
    }
});

export default class ZweitbildschirmExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new Indicator(this, this._settings);
        this._indicator.connect('destroy', () => {
            this._indicator = null;
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this.controller = new Controller(this, this._settings, () => this._indicator?.update(this.controller?.status.peers ?? []));
        this._transition = new Transition(this._settings);
        this._windows = new TabletWindows(this._settings, this._transition);
        this._layout = new LayoutKeeper(this._settings, () => this._windows?.settled());
    }

    disable() {
        // Bleibt bei gesperrtem Bildschirm aktiv (session-modes unlock-dialog), damit die
        // Verbindung zum Tablet beim Sperren nicht abbricht.
        this._windows?.destroy();
        this._layout?.destroy();
        this._transition?.destroy();
        this.controller?.destroy();
        this._indicator?.destroy();
        this._source?.destroy();
        this._windows = this._layout = this._transition = this.controller = this._indicator = this._source = null;
        this._settings = null;
    }

    notify(title, body, transient = false) {
        if (!this._settings?.get_boolean('notifications'))
            return;
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Zweitbildschirm', iconName: ICON});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({source: this._source, title, body, isTransient: transient});
        this._source.addNotification(n);
    }
}
