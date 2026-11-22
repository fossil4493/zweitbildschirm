// Optionaler Firewall-Helfer (make install): öffnet Port 3389 nur für freigegebene Geräte (MAC).
import GLib from 'gi://GLib';

import {run} from './util.js';

const DIRS = ['/usr/local/libexec', '/usr/libexec', '/usr/lib/zweitbildschirm'];

function helper(name) {
    for (const d of DIRS) {
        const p = `${d}/${name}`;
        if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
            return p;
    }
    return null;
}

export const installed = () => !!helper('zweitbildschirm-firewall');

async function call(...args) {
    const h = helper('zweitbildschirm-firewall');
    if (!h)
        return {ok: false, status: -1, out: '', err: 'Helfer nicht installiert'};
    return run(['pkexec', h, ...args], {timeout: 30});
}

export const open = () => call('open');
export const close = () => call('close');
export const rules = async () => (await call('status')).out.trim();

export async function allowedMacs() {
    const r = await call('macs');
    return r.out.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Gerät mit dieser IP freigeben – fragt nach dem Admin-Passwort. */
export async function approve(ip) {
    const h = helper('zweitbildschirm-freigabe');
    if (!h)
        return {ok: false, status: -1, out: '', err: 'Helfer nicht installiert'};
    return run(['pkexec', h, ip], {timeout: 300});
}

/** MAC-Adresse einer IP im lokalen Netz (aus der Nachbartabelle). */
export async function macOf(ip) {
    const r = await run(['ip', 'neigh', 'show', ip]);
    return r.out.match(/lladdr\s+(\S+)/)?.[1]?.toLowerCase() ?? null;
}
