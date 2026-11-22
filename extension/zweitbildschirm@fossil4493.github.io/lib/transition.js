// Übergang beim Verbinden/Trennen des Tablets: Während GNOME Monitore umbaut und Fenster
// verschiebt, legt sich eine dunkle Fläche mit Ladekreis über alle Bildschirme; ist alles an
// seinem Platz, blendet sie wieder aus. Kein Effekt auf den Fenstern selbst (Unschärfe auf
// der Fenstergruppe flackerte, weil GNOME sie beim Umbau der Monitore neu aufbaut).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

const IN_MS = 150;
const OUT_MS = 300;
const DIM = 215;   // Deckkraft 0–255

export class Transition {
    constructor(settings) {
        this._settings = settings;
        this._timeout = 0;
        this._active = false;
        this._overlay = new St.Widget({
            style: 'background-color: black;',
            reactive: false,
            opacity: 0,
            visible: false,
        });
        this._overlay.add_constraint(new Clutter.BindConstraint({
            source: global.stage, coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._spinner = new Animation.Spinner(48, {hideOnStop: true});
        this._overlay.add_child(this._spinner);
        Main.layoutManager.uiGroup.add_child(this._overlay);
    }

    _placeSpinner() {
        const m = Main.layoutManager.primaryMonitor;
        if (m)
            this._spinner.set_position(m.x + Math.round(m.width / 2) - 24, m.y + Math.round(m.height / 2) - 24);
    }

    /** Übergang beginnen (oder verlängern); endet spätestens nach maxMs von selbst. */
    begin(maxMs = 5000) {
        if (!this._settings.get_boolean('animate-transitions'))
            return;
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, maxMs, () => {
            this._timeout = 0;
            this.end();
            return GLib.SOURCE_REMOVE;
        });
        this._placeSpinner();
        if (this._active)
            return;
        this._active = true;
        const o = this._overlay;
        o.get_parent().set_child_above_sibling(o, null);
        o.remove_all_transitions();
        o.show();
        this._spinner.play();
        o.ease({opacity: DIM, duration: IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    end() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        if (!this._active)
            return;
        this._active = false;
        const o = this._overlay;
        o.remove_all_transitions();
        o.ease({
            opacity: 0, duration: OUT_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!this._active) {
                    this._spinner.stop();
                    o.hide();
                }
            },
        });
    }

    destroy() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._overlay.destroy();
    }
}
