// Hilfsfunktionen: Programme asynchron starten, Dateien lesen/schreiben.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.DBusProxy.prototype, 'call');

/**
 * Programm starten und auf das Ende warten, ohne die Shell zu blockieren.
 * @returns {Promise<{ok: boolean, status: number, out: string, err: string}>}
 */
export async function run(argv, {input = null, timeout = 20} = {}) {
    let proc;
    try {
        let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
        if (input !== null)
            flags |= Gio.SubprocessFlags.STDIN_PIPE;
        proc = Gio.Subprocess.new(argv, flags);
    } catch (e) {
        return {ok: false, status: -1, out: '', err: e.message};
    }
    let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
        timer = 0;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [out, err] = await proc.communicate_utf8_async(input, null);
        return {
            ok: proc.get_successful(),
            status: proc.get_if_exited() ? proc.get_exit_status() : -1,
            out: out ?? '',
            err: err ?? '',
        };
    } catch (e) {
        return {ok: false, status: -1, out: '', err: e.message};
    } finally {
        if (timer)
            GLib.source_remove(timer);
    }
}

export function findProgram(name, extra = []) {
    for (const p of extra) {
        if (p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
            return p;
    }
    return GLib.find_program_in_path(name);
}

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

export function writeText(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, text);
}

export function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

/** IPv4-Adressen des Laptops: [{dev, ip}] ohne Loopback, Docker, VPN-Tunnel. */
export async function localAddresses() {
    const r = await run(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global']);
    const list = [];
    for (const line of r.out.split('\n')) {
        const m = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\//);
        if (m && !/^(docker|br-|veth|virbr|wg|tun|tap)/.test(m[1]))
            list.push({dev: m[1], ip: m[2]});
    }
    return list;
}
