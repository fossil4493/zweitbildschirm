// Fenster an ihrem Platz halten, wenn das Tablet kommt oder geht.
//
// Verschwindet oder erscheint der virtuelle Monitor des Tablets, baut GNOME alle Monitore um:
// Fenster vom Tablet landen auf dem Hauptbildschirm, und auch Fenster auf den echten Monitoren
// können dabei auf einen anderen Monitor rutschen. Deshalb wird jede Sekunde festgehalten, auf
// welchem Monitor (Anschluss) und wo jedes Fenster liegt; nach dem Umbau kommt jedes Fenster auf
// seinen Monitor und an seine Stelle zurück. Fenster vom Tablet warten, bis es wieder da ist.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const isTablet = c => c?.startsWith('Meta-');

export class TabletWindows {
    constructor(settings, transition) {
        this._settings = settings;
        this._transition = transition;
        this._snapshot = new Map();     // MetaWindow -> {conn, x, y, w, h, max, full}
        this._tabletPending = null;     // Fenster vom Tablet, bis es wieder da ist
        this._busy = false;             // während eines Umbaus keine Schnappschüsse
        this._waiting = false;
        this._fallbackId = 0;
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._onMonitors());
        this._wasPresent = this._tabletIndex() >= 0;
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
            if (!this._busy)
                this._takeSnapshot();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Anschluss -> Monitor-Index der gerade vorhandenen Monitore. */
    _monitorMap() {
        const mm = global.backend.get_monitor_manager();
        const map = new Map();
        for (const m of mm.get_monitors()) {
            const c = m.get_connector();
            const idx = mm.get_monitor_for_connector(c);
            if (idx >= 0)
                map.set(c, idx);
        }
        return map;
    }

    _tabletIndex() {
        for (const [c, idx] of this._monitorMap()) {
            if (isTablet(c))
                return idx;
        }
        return -1;
    }

    _takeSnapshot() {
        const byIndex = new Map([...this._monitorMap()].map(([c, i]) => [i, c]));
        const snap = new Map();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || win.is_skip_taskbar())
                continue;
            const idx = win.get_monitor();
            const conn = byIndex.get(idx);
            if (!conn)
                continue;
            const geo = global.display.get_monitor_geometry(idx);
            const r = win.get_frame_rect();
            snap.set(win, {
                conn, x: r.x - geo.x, y: r.y - geo.y, w: r.width, h: r.height,
                max: typeof win.is_maximized === 'function' ? win.is_maximized() : false,
                full: win.is_fullscreen(),
            });
        }
        this._snapshot = snap;
    }

    _onMonitors() {
        const present = this._tabletIndex() >= 0;
        if (present === this._wasPresent)
            return;
        this._wasPresent = present;
        this._busy = true;
        const before = this._snapshot;   // Stand vor dem Umbau
        if (!present) {
            // Tablet weg: dessen Fenster aufheben; echte Monitore nach dem Umbau zurücksetzen.
            // Kurz: kommt die Verbindung nicht gleich wieder (z. B. Wechsel Kabel/WLAN), endet er.
            this._tabletPending = new Map([...before].filter(([, s]) => isTablet(s.conn)));
            this._transition.begin(3500);
            this._schedule(before, 1200);
        } else {
            // Tablet da: warten, bis die Anordnung steht (settled), sonst nach einer Frist
            this._transition.begin(5000);
            this._schedule(before, this._settings.get_boolean('remember-layout') ? 3000 : 600);
        }
    }

    _schedule(before, fallbackMs) {
        this._before = before;
        this._waiting = true;
        if (this._fallbackId)
            GLib.source_remove(this._fallbackId);
        this._fallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, fallbackMs, () => {
            this._fallbackId = 0;
            this.settled();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Anordnung steht: Fenster zurück an ihren Platz, Übergang beenden. */
    settled() {
        if (!this._waiting)
            return;
        this._waiting = false;
        if (this._fallbackId) {
            GLib.source_remove(this._fallbackId);
            this._fallbackId = 0;
        }
        // einen Moment warten, bis GNOME die neuen Monitorgrenzen übernommen hat
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (this._settings.get_boolean('restore-windows')) {
                const states = new Map(this._before ?? []);
                if (this._tabletIndex() >= 0 && this._tabletPending) {
                    for (const [w, s] of this._tabletPending)
                        states.set(w, s);
                    this._tabletPending = null;
                }
                this._restore(states);
            }
            this._before = null;
            this._busy = false;
            this._takeSnapshot();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                this._transition.end();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _restore(states) {
        const monitors = this._monitorMap();
        const tabletIdx = this._tabletIndex();
        const alive = new Set(global.get_window_actors().map(a => a.meta_window));
        for (const [win, st] of states) {
            if (!alive.has(win))
                continue;
            const idx = isTablet(st.conn) ? tabletIdx : monitors.get(st.conn) ?? -1;
            if (idx < 0)
                continue;   // Monitor gerade nicht da (z. B. Tablet weg): GNOME-Platz lassen
            const geo = global.display.get_monitor_geometry(idx);
            const r = win.get_frame_rect();
            const same = win.get_monitor() === idx && r.x - geo.x === st.x && r.y - geo.y === st.y;
            if (same)
                continue;
            try {
                if (win.get_monitor() !== idx)
                    win.move_to_monitor(idx);
                if (!st.max && !st.full) {
                    const w = Math.min(st.w, geo.width), h = Math.min(st.h, geo.height);
                    const x = geo.x + Math.max(0, Math.min(st.x, geo.width - w));
                    const y = geo.y + Math.max(0, Math.min(st.y, geo.height - h));
                    win.move_resize_frame(true, x, y, w, h);
                }
            } catch (e) {
                logError(e, 'Zweitbildschirm: Fenster zurückholen');
            }
        }
    }

    destroy() {
        Main.layoutManager.disconnect(this._monitorsId);
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._fallbackId)
            GLib.source_remove(this._fallbackId);
        this._snapshot.clear();
        this._tabletPending = null;
    }
}
