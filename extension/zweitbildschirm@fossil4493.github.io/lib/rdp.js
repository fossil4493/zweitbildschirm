// GNOME Remote Desktop (RDP) im Modus „Bildschirm erweitern“ steuern.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {run, findProgram, readText, writeText} from './util.js';

const RDP_SCHEMA = 'org.gnome.desktop.remote-desktop.rdp';
const UNIT = 'gnome-remote-desktop.service';
export const PORT = 3389;
const CERT_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-remote-desktop']);
const CERT = GLib.build_filenamev([CERT_DIR, 'zweitbildschirm.crt']);
const KEY = GLib.build_filenamev([CERT_DIR, 'zweitbildschirm.key']);
const SAVED = GLib.build_filenamev([GLib.get_user_state_dir(), 'zweitbildschirm', 'remote-desktop-vorher.json']);
const OWN_KEYS = {
    'screen-share-mode': 's', 'view-only': 'b', 'negotiate-port': 'b', 'port': 'u', 'enable': 'b',
};

export function available() {
    const src = Gio.SettingsSchemaSource.get_default();
    return !!src.lookup(RDP_SCHEMA, true) && !!findProgram('grdctl');
}

function settings() {
    return new Gio.Settings({schema_id: RDP_SCHEMA});
}

export async function status() {
    const r = await run(['grdctl', 'status', '--show-credentials']);
    const text = r.out;
    const get = re => text.match(re)?.[1]?.trim();
    const user = get(/Username:\s*(.*)/);
    return {
        user: user && user !== '(empty)' ? user : '',
        hasPassword: !!get(/Password:\s*(.*)/) && get(/Password:\s*(.*)/) !== '(empty)',
        fingerprint: get(/TLS fingerprint:\s*(\S+)/) ?? '',
        cert: get(/TLS certificate:\s*(.*)/) ?? '',
    };
}

/** Eigenes Zertifikat anlegen, falls GNOME Remote Desktop noch keins hat. */
export async function ensureCertificate() {
    const st = await status();
    if (st.cert && GLib.file_test(st.cert, GLib.FileTest.EXISTS) && st.fingerprint && st.fingerprint !== '(null)')
        return true;
    GLib.mkdir_with_parents(CERT_DIR, 0o700);
    const host = GLib.get_host_name();
    const r = await run(['openssl', 'req', '-new', '-newkey', 'rsa:4096', '-days', '3650', '-nodes', '-x509',
        '-subj', `/CN=${host}-zweitbildschirm`, '-keyout', KEY, '-out', CERT], {timeout: 60});
    if (!r.ok)
        return false;
    await run(['chmod', '600', KEY]);
    await run(['grdctl', 'rdp', 'set-tls-key', KEY]);
    await run(['grdctl', 'rdp', 'set-tls-cert', CERT]);
    return true;
}

async function credentialsAre(user, password) {
    const st = await run(['grdctl', 'status', '--show-credentials']);
    return st.out.match(/Username:\s*(.*)/)?.[1]?.trim() === user &&
        st.out.match(/Password:\s*(.*)/)?.[1]?.trim() === password;
}

/** Das Passwort geht über stdin, damit es nicht in der Prozessliste steht; ältere grdctl-Versionen
 *  lesen es nur von der Kommandozeile. */
export async function setCredentials(user, password) {
    let r = await run(['grdctl', 'rdp', 'set-credentials', user], {input: `${password}\n`});
    if (await credentialsAre(user, password))
        return {...r, ok: true};
    r = await run(['grdctl', 'rdp', 'set-credentials', user, password]);
    if (await credentialsAre(user, password))
        return {...r, ok: true};
    return {...r, ok: false, err: r.err || 'Zugang wurde nicht übernommen'};
}

function saveOriginal(s) {
    if (GLib.file_test(SAVED, GLib.FileTest.EXISTS))
        return;
    const old = {};
    for (const k of Object.keys(OWN_KEYS))
        old[k] = s.get_value(k).deepUnpack();
    if (old.enable && old['screen-share-mode'] === 'extend')
        old.enable = false;
    writeText(SAVED, JSON.stringify(old));
}

function restoreOriginal(s) {
    let old;
    try {
        old = JSON.parse(readText(SAVED) ?? 'null');
    } catch {
        old = null;
    }
    if (old) {
        for (const [k, type] of Object.entries(OWN_KEYS)) {
            if (k in old)
                s.set_value(k, new GLib.Variant(type, old[k]));
        }
    } else {
        s.set_boolean('enable', false);
    }
    GLib.unlink(SAVED);
    return old;
}

export async function start() {
    const s = settings();
    saveOriginal(s);
    s.set_string('screen-share-mode', 'extend');
    s.set_boolean('view-only', false);
    s.set_boolean('negotiate-port', false);
    s.set_uint('port', PORT);
    s.set_boolean('enable', true);
    Gio.Settings.sync();
    // restart statt start: Läuft der Dienst noch aus einer früheren Anmeldung, hält er eine
    // veraltete Verbindung zum Schlüsselbund und findet die Zugangsdaten nicht mehr
    // („Couldn't retrieve RDP credentials: The name is not activatable“).
    await run(['systemctl', '--user', 'restart', UNIT]);
}

/** Vorherige Einstellungen von GNOME Remote Desktop wiederherstellen; lief die Freigabe schon
 *  vorher, bleibt der Dienst an. */
export async function stop() {
    const s = settings();
    const old = restoreOriginal(s);
    Gio.Settings.sync();
    await run(['systemctl', '--user', old?.enable ? 'restart' : 'stop', UNIT]);
}

/** Gegenstellen aktiver RDP-Verbindungen, z. B. ["127.0.0.1", "192.168.1.50"]. */
export async function peers() {
    const r = await run(['ss', '-Htn', 'state', 'established', `( sport = :${PORT} )`]);
    return r.out.split('\n').filter(l => l.trim()).map(l => {
        const peer = l.trim().split(/\s+/).pop();
        return peer.replace(/^\[(::ffff:)?/, '').replace(/\]?:\d+$/, '');
    });
}
