// Bildschirm-Anordnung stabil halten, solange das Tablet verbunden ist.
//
// GNOME merkt sich Anordnungen in ~/.config/monitors.xml je Kombination von Monitoren.
// Der virtuelle Monitor des Tablets bekommt bei jeder Verbindung eine neue Seriennummer,
// die Kombination ist also jedes Mal unbekannt, und GNOME setzt ALLE Monitore zurück.
// Hier wird die Anordnung je Kombination der echten Monitore gespeichert und beim
// Verbinden wiederhergestellt (sonst: GNOMEs Anordnung der echten Monitore aus
// monitors.xml, Tablet links neben dem Hauptbildschirm).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readText, writeText} from './util.js';

const STORE = GLib.build_filenamev([GLib.get_user_config_dir(), 'zweitbildschirm-layout.json']);
const MONITORS_XML = GLib.build_filenamev([GLib.get_user_config_dir(), 'monitors.xml']);
const TABLET_SCALE = 2.0;

const isVirtual = spec => spec[0].startsWith('Meta-');
const specId = spec => spec.slice(0, 4).join('|');

function loadStore() {
    try {
        const d = JSON.parse(readText(STORE) ?? '{}');
        return d.layouts ? d : {layouts: {}, tablet_default: null};
    } catch {
        return {layouts: {}, tablet_default: null};
    }
}

function saveStore(d) {
    writeText(STORE, JSON.stringify(d, null, 1));
}

export function clearStore() {
    try {
        Gio.File.new_for_path(STORE).delete(null);
        return true;
    } catch {
        return false;
    }
}

/** Anordnung aus monitors.xml, falls GNOME genau diese Kombination kennt. */
function gnomeLayout(key) {
    const xml = readText(MONITORS_XML);
    if (!xml)
        return null;
    const tag = (s, t) => s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    for (const conf of xml.split('<configuration>').slice(1)) {
        const entries = {};
        for (const lm of conf.split('<logicalmonitor>').slice(1)) {
            const body = lm.split('</logicalmonitor>')[0];
            const spec = body.match(/<monitorspec>([\s\S]*?)<\/monitorspec>/)?.[1];
            if (!spec)
                continue;
            const sid = ['connector', 'vendor', 'product', 'serial'].map(t => tag(spec, t)).join('|');
            entries[sid] = {
                x: parseInt(tag(body, 'x')), y: parseInt(tag(body, 'y')),
                scale: parseFloat(tag(body, 'scale')), primary: tag(body, 'primary') === 'yes',
            };
        }
        if (Object.keys(entries).sort().join(',') === key)
            return entries;
    }
    return null;
}

const nearest = (s, allowed) => allowed.includes(s) ? s
    : allowed.reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a);
const overlaps = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export class LayoutKeeper {
    constructor(settings, onSettled = null) {
        this._settings = settings;
        this._onSettled = onSettled;   // nach dem Wiederherstellen beim Verbinden
        this._seen = null;
        this._pending = 0;
        this._proxy = null;
        this._cancel = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', this._cancel, (_o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'Zweitbildschirm: DisplayConfig');
                    return;
                }
                this._signalId = this._proxy.connect('g-signal', (_p, _s, name) => {
                    if (name !== 'MonitorsChanged')
                        return;
                    if (this._pending)
                        GLib.source_remove(this._pending);
                    this._pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        this._pending = 0;
                        this._changed().catch(e => logError(e, 'Zweitbildschirm: Anordnung'));
                        return GLib.SOURCE_REMOVE;
                    });
                });
                this._state().then(st => {
                    this._seen = st.virt ? `${st.virt[5][0][3]}/${st.key}` : null;
                }).catch(() => {});
            });
    }

    async _state() {
        const v = await this._proxy.call('GetCurrentState', null, Gio.DBusCallFlags.NONE, -1, null);
        const [serial, monitors, logical] = v.recursiveUnpack();
        const modes = {};
        for (const [spec, ms] of monitors) {
            for (const m of ms) {
                if (m[6]['is-current'])
                    modes[spec[0]] = {id: m[0], w: m[1], h: m[2], scales: m[5]};
            }
        }
        let virt = null;
        const phys = [];
        for (const lm of logical) {
            if (lm[5].some(isVirtual))
                virt = lm;
            else
                phys.push(lm);
        }
        const key = phys.flatMap(lm => lm[5].map(specId)).sort().join(',');
        return {serial, modes, logical, virt, phys, key};
    }

    _size(st, lm, scale) {
        const m = st.modes[lm[5][0][0]];
        let [w, h] = [m.w, m.h];
        if ([1, 3, 5, 7].includes(lm[3]))
            [w, h] = [h, w];
        return [Math.round(w / scale), Math.round(h / scale)];
    }

    _plan(st, store) {
        const stored = store.layouts[st.key];
        const base = stored ? stored.phys : gnomeLayout(st.key);
        const out = st.phys.map(lm => {
            const e = base?.[specId(lm[5][0])];
            return e ? [lm, e.x, e.y, nearest(e.scale, st.modes[lm[5][0][0]].scales), e.primary]
                : [lm, lm[0], lm[1], lm[2], lm[4]];
        });
        if (out.length && !out.some(o => o[4]))
            out[0][4] = true;
        if (st.virt) {
            const vscales = st.modes[st.virt[5][0][0]].scales;
            if (stored?.tablet) {
                const t = stored.tablet;
                out.push([st.virt, t.x, t.y, nearest(t.scale, vscales), false]);
            } else {
                const vs = nearest(store.tablet_default?.scale ?? TABLET_SCALE, vscales);
                const [tw, th] = this._size(st, st.virt, vs);
                const rects = out.map(o => [o[1], o[2], ...this._size(st, o[0], o[3])]);
                const prim = out.find(o => o[4]);
                if (!prim) {
                    out.push([st.virt, 0, 0, vs, true]);
                    return out;
                }
                const [, ph] = this._size(st, prim[0], prim[3]);
                let cand = [prim[1] - tw, prim[2] + ph - th, tw, th];
                if (rects.some(r => overlaps(cand, r))) {
                    const left = rects.reduce((a, b) => b[0] < a[0] ? b : a);
                    cand = [left[0] - tw, left[1] + left[3] - th, tw, th];
                }
                out.push([st.virt, cand[0], cand[1], vs, false]);
            }
        }
        return out;
    }

    async apply() {
        if (!this._proxy || this._cancel.is_cancelled() || !this._settings.get_boolean('remember-layout'))
            return;
        const st = await this._state();
        if (!st.virt)
            return;
        const out = this._plan(st, loadStore());
        const mx = Math.min(...out.map(o => o[1])), my = Math.min(...out.map(o => o[2]));
        const cur = st.logical.map(lm => [lm[0], lm[1], lm[2], lm[4]].join()).sort().join(';');
        const want = out.map(o => [o[1] - mx, o[2] - my, o[3], o[4]].join()).sort().join(';');
        if (cur === want)
            return;
        const lms = out.map(o => [o[1] - mx, o[2] - my, o[3], o[0][3], o[4],
            o[0][5].map(s => [s[0], st.modes[s[0]].id, {}])]);
        const args = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [st.serial, 1, lms, {}]);
        await this._proxy.call('ApplyMonitorsConfig', args, Gio.DBusCallFlags.NONE, -1, null);
    }

    async remember() {
        const st = await this._state();
        if (!st.virt)
            return;
        const store = loadStore();
        const phys = {};
        for (const lm of st.phys)
            phys[specId(lm[5][0])] = {x: lm[0], y: lm[1], scale: lm[2], primary: lm[4]};
        store.layouts[st.key] = {phys, tablet: {x: st.virt[0], y: st.virt[1], scale: st.virt[2]}};
        store.tablet_default = {scale: st.virt[2]};
        saveStore(store);
    }

    async _changed() {
        if (!this._proxy || !this._settings.get_boolean('remember-layout'))
            return;
        const st = await this._state();
        const now = st.virt ? `${st.virt[5][0][3]}/${st.key}` : null;
        if (now === null)
            this._seen = null;
        else if (now !== this._seen) {
            this._seen = now;            // Tablet neu oder andere Monitore: wiederherstellen
            try {
                await this.apply();
            } finally {
                this._onSettled?.();
            }
        } else {
            await this.remember();       // gleiche Kombination geändert (z. B. Einstellungen): merken
        }
    }

    destroy() {
        this._cancel.cancel();
        if (this._pending)
            GLib.source_remove(this._pending);
        if (this._proxy && this._signalId)
            this._proxy.disconnect(this._signalId);
        this._proxy = null;
    }
}
