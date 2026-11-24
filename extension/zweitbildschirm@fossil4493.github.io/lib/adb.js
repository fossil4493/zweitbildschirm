// Optionale Android-Automatik über adb (Entwickleroptionen am Tablet nötig):
// Tablet erkennen, Tunnel per Kabel, App öffnen, Vento automatisch verbinden.
import GLib from 'gi://GLib';

import {run, findProgram} from './util.js';

export const USB_ADDR = '127.0.0.1:3389';
const WLAN_ID = 'zweitbildschirm-wlan';
const MS_APP = 'com.microsoft.rdc.androidx/com.microsoft.rdc.ui.activities.HomeActivity';
const VENTO_PKGS = ['net.pgaskin.remotedesktop', 'net.pgaskin.remotedesktop.debug'];

export const isUsb = t => !t.includes(':') && !t.includes('._adb');

const unescapeXml = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function prefsXml(entries) {
    const lines = [...entries].map(([k, v]) => `    <string name="${escapeXml(k)}">${escapeXml(v)}</string>\n`);
    return `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${lines.join('')}</map>\n`;
}

export class Adb {
    constructor(settings) {
        this._settings = settings;
        this._serials = new Map();   // Verbindung -> Seriennummer
        this._vento = new Map();     // Verbindung -> Paketname
    }

    path() {
        const own = this._settings.get_string('adb-path');
        return findProgram('adb', [own, GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'adb'])]);
    }

    async _adb(args, serial = null, opts = {}) {
        const adb = this.path();
        if (!adb)
            return {ok: false, status: -1, out: '', err: 'adb fehlt'};
        return run([adb, ...(serial ? ['-s', serial] : []), ...args], opts);
    }

    async _online() {
        const r = await this._adb(['devices']);
        if (!r.ok)
            return [];
        const found = [];
        for (const line of r.out.split('\n').slice(1)) {
            const [t, state] = line.trim().split(/\s+/);
            if (state !== 'device')
                continue;
            if (!this._serials.get(t)) {
                const serial = (await this._adb(['shell', 'getprop', 'ro.serialno'], t)).out.trim();
                if (serial)
                    this._serials.set(t, serial);
            }
            found.push(t);
        }
        for (const t of this._serials.keys()) {
            if (!found.includes(t))
                this.forget(t);
        }
        return found.sort((a, b) => isUsb(b) - isUsb(a));
    }

    /** Verbindungen zum Tablet, USB zuerst. */
    async transports() {
        const want = this._settings.get_string('tablet-serial').trim();
        const found = (await this._online()).filter(t => !want || this._serials.get(t) === want);
        if (!want && found.length) {
            // ohne Vorgabe: erstes Gerät, auch über WLAN dasselbe
            const s = this._serials.get(found[0]);
            return found.filter(t => this._serials.get(t) === s);
        }
        return found;
    }

    serialOf(t) {
        return this._serials.get(t) || t;
    }

    async transportOf(serial) {
        return (await this._online()).find(t => this.serialOf(t) === serial) ?? null;
    }

    /** IPv4-Adresse des Tablets bei einer WLAN-Verbindung („ip:port“ oder mDNS-Name). */
    async ipOf(t) {
        const direct = t.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)?.[1];
        if (direct)
            return direct;
        const name = t.split('._adb')[0];
        const r = await this._adb(['mdns', 'services'], null, {timeout: 5});
        for (const line of r.out.split('\n')) {
            const f = line.trim().split(/\s+/);
            const ip = f[0] === name ? f.at(-1).match(/^(\d+\.\d+\.\d+\.\d+):/)?.[1] : null;
            if (ip)
                return ip;
        }
        const own = await this._adb(['shell', 'ip', '-4', '-o', 'addr', 'show', 'wlan0'], t, {timeout: 5});
        return own.out.match(/inet\s+([\d.]+)\//)?.[1] ?? null;
    }

    async connectWireless() {
        const r = await this._adb(['mdns', 'services'], null, {timeout: 5});
        for (const line of r.out.split('\n')) {
            if (line.includes('_adb-tls-connect'))
                await this._adb(['connect', line.trim().split(/\s+/).pop()], null, {timeout: 5});
        }
    }

    /** Bildschirm aus (Tablet sperrt sich) bzw. an (Sperrbildschirm erscheint). */
    sleep(t) {
        return this._adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'], t, {timeout: 5});
    }

    wake(t) {
        return this._adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], t, {timeout: 5});
    }

    reverse(t) {
        return this._adb(['reverse', 'tcp:3389', 'tcp:3389'], t);
    }

    unreverse(t) {
        return this._adb(['reverse', '--remove', 'tcp:3389'], t, {timeout: 3});
    }

    async hasReverse(t) {
        return (await this._adb(['reverse', '--list'], t)).out.includes('tcp:3389');
    }

    // ---------------------------------------------------------------- Vento

    async _ventoPkg(t) {
        if (!this._vento.has(t)) {
            const r = await this._adb(['shell', 'pm', 'list', 'packages'], t);
            const lines = r.out.split('\n').map(l => l.trim());
            const pkg = VENTO_PKGS.find(p => lines.includes(`package:${p}`));
            if (!pkg)
                return null;
            this._vento.set(t, pkg);
        }
        return this._vento.get(t);
    }

    async _read(t, pkg, name) {
        const r = await this._adb(['exec-out', `run-as ${pkg} cat shared_prefs/${name}`], t);
        return r.ok ? r.out : '';
    }

    _write(t, pkg, name, text) {
        return this._adb(['exec-in', `run-as ${pkg} sh -c 'cat > shared_prefs/${name}'`], t, {input: text});
    }

    async _connections(t, pkg) {
        const m = (await this._read(t, pkg, 'connections.xml')).match(/name="list">([\s\S]*?)<\/string>/);
        if (!m)
            return null;
        try {
            return JSON.parse(unescapeXml(m[1]));
        } catch {
            return null;
        }
    }

    /** Vento-Verbindung „… (WLAN)“ auf die WLAN-Adresse des Laptops setzen; liefert ihre ID. */
    async prepareWlan(t, laptopIp, fingerprint) {
        const pkg = await this._ventoPkg(t);
        if (!pkg)
            return null;   // nur die Debug-Variante erlaubt run-as; sonst bleibt es beim Öffnen der App
        const conns = await this._connections(t, pkg);
        const usb = conns?.find(c => c.address === USB_ADDR);
        if (!usb)
            return null;
        const addr = `${laptopIp}:3389`;
        const want = {...usb, id: WLAN_ID, name: `${usb.name} (WLAN)`, address: addr};
        const cur = conns.find(c => c.id === WLAN_ID);
        const hosts = new Map([...(await this._read(t, pkg, 'known_hosts.xml'))
            .matchAll(/<string name="([^"]*)">([^<]*)<\/string>/g)].map(m => [unescapeXml(m[1]), unescapeXml(m[2])]));
        const needHost = fingerprint && hosts.get(addr) !== fingerprint.toLowerCase();
        if (JSON.stringify(cur) === JSON.stringify(want) && !needHost)
            return WLAN_ID;
        await this._adb(['shell', 'am', 'force-stop', pkg], t);
        const list = conns.filter(c => c.id !== WLAN_ID).concat([want]);
        await this._write(t, pkg, 'connections.xml', prefsXml(new Map([['list', JSON.stringify(list)]])));
        if (needHost) {
            hosts.set(addr, fingerprint.toLowerCase());
            await this._write(t, pkg, 'known_hosts.xml', prefsXml(hosts));
        }
        return WLAN_ID;
    }

    async usbConnection(t, user) {
        const pkg = await this._ventoPkg(t);
        const conns = pkg ? await this._connections(t, pkg) : null;
        const c = conns?.find(x => x.address === USB_ADDR);
        if (!c)
            return {id: null, problem: null};
        const fixes = [];
        if (this._settings.get_string('tablet-app') === 'vento') {
            if (c.backend !== 'freerdp')
                fixes.push('Backend „FreeRDP“ wählen');
            if (user && (c.user ?? '') !== user)
                fixes.push(`Benutzer „${user}“ eintragen`);
        }
        return {id: c.id, problem: fixes.length ? `Verbindung „${c.name}“ (${USB_ADDR}): ${fixes.join(', ')}.` : null};
    }

    /** App auf dem Tablet öffnen; bei Vento wenn möglich direkt die Verbindung starten. */
    async openApp(t, connId, {fresh = false} = {}) {
        const app = this._settings.get_string('tablet-app');
        if (app === 'none')
            return;
        if (app === 'microsoft') {
            await this._adb(['shell', 'am', 'start', '-n', MS_APP], t);
            return;
        }
        const pkg = await this._ventoPkg(t);
        if (!pkg)
            return;
        // ein altes, getrenntes Sitzungsfenster würde nur nach vorn geholt -> neu starten
        if (fresh)
            await this._adb(['shell', 'am', 'force-stop', pkg], t);
        if (connId && this._settings.get_boolean('auto-connect')) {
            await this._adb(['shell', 'am', 'start', '-n', `${pkg}/net.pgaskin.remotedesktop.SessionActivity`,
                '-d', `connection:${connId}`, '--es', 'connection', connId], t);
        } else {
            await this._adb(['shell', 'am', 'start', '-n', `${pkg}/net.pgaskin.remotedesktop.HomeActivity`], t);
        }
    }

    forget(t) {
        this._serials.delete(t);
        this._vento.delete(t);
    }
}
