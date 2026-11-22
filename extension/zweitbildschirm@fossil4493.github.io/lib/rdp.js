// GNOME Remote Desktop (RDP) im Modus „Bildschirm erweitern“ steuern.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {run, findProgram} from './util.js';

const RDP_SCHEMA = 'org.gnome.desktop.remote-desktop.rdp';
const UNIT = 'gnome-remote-desktop.service';
export const PORT = 3389;
const CERT_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-remote-desktop']);
const CERT = GLib.build_filenamev([CERT_DIR, 'tablet-zweitbildschirm.crt']);
const KEY = GLib.build_filenamev([CERT_DIR, 'tablet-zweitbildschirm.key']);

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
        '-subj', `/CN=${host}-tablet-zweitbildschirm`, '-keyout', KEY, '-out', CERT], {timeout: 60});
    if (!r.ok)
        return false;
    await run(['chmod', '600', KEY]);
    await run(['grdctl', 'rdp', 'set-tls-key', KEY]);
    await run(['grdctl', 'rdp', 'set-tls-cert', CERT]);
    return true;
}

export async function setCredentials(user, password) {
    return run(['grdctl', 'rdp', 'set-credentials', user, password]);
}

export async function start() {
    const s = settings();
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

export async function stop() {
    const s = settings();
    s.set_boolean('enable', false);
    Gio.Settings.sync();
    await run(['systemctl', '--user', 'stop', UNIT]);
}

/** Gegenstellen aktiver RDP-Verbindungen, z. B. ["127.0.0.1", "192.168.1.50"]. */
export async function peers() {
    const r = await run(['ss', '-Htn', 'state', 'established', `( sport = :${PORT} )`]);
    return r.out.split('\n').filter(l => l.trim()).map(l => {
        const peer = l.trim().split(/\s+/).pop();
        return peer.replace(/^\[(::ffff:)?/, '').replace(/\]?:\d+$/, '');
    });
}
