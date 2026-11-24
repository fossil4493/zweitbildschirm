// Tonausgabegerät „Tablet“.
//
// GNOME Remote Desktop greift JEDES Ausgabegerät ab und schickt dessen Ton an den Client.
// Damit nur das Gerät „Tablet“ dort landet, werden alle Tonstreams von GNOME Remote Desktop
// auf den Monitor dieses (stummen) Null-Sinks umgehängt – nicht getrennt, damit GNOME Remote
// Desktop weiter Stille bekommt und die Sperre auf einen spielenden Stream wieder freigibt.
import {run, findProgram} from './util.js';

const SINK = 'tablet_lautsprecher';

export function available() {
    return !!(findProgram('pactl') && findProgram('pw-dump') && findProgram('pw-link') && findProgram('pw-cli'));
}

/** Gerät „Tablet“ anlegen; war es beim letzten Entfernen die Standardausgabe, wieder dazu machen. */
export async function load(makeDefault = false) {
    const r = await run(['pactl', 'list', 'short', 'sinks']);
    if (!r.out.includes(SINK)) {
        await run(['pactl', 'load-module', 'module-null-sink', `sink_name=${SINK}`,
            'sink_properties=device.description=Tablet']);
    }
    if (makeDefault)
        await run(['pactl', 'set-default-sink', SINK]);
}

export async function isDefault() {
    return (await run(['pactl', 'get-default-sink'])).out.trim() === SINK;
}

/** Gerät entfernen – der Ton geht dann wieder über die vorherige Ausgabe. */
export async function unload() {
    const r = await run(['pactl', 'list', 'short', 'modules']);
    for (const line of r.out.split('\n')) {
        if (line.includes('module-null-sink') && line.includes(`sink_name=${SINK}`))
            await run(['pactl', 'unload-module', line.split('\t')[0]]);
    }
}

export async function onlyTablet() {
    const r = await run(['pw-dump'], {timeout: 5});
    let d;
    try {
        d = JSON.parse(r.out || '[]');
    } catch {
        return;
    }
    const props = o => o?.info?.props ?? {};
    const nodes = new Map(), ports = new Map(), links = [];
    for (const o of d) {
        if (o.type?.endsWith('Node'))
            nodes.set(o.id, props(o));
        else if (o.type?.endsWith('Port'))
            ports.set(o.id, props(o));
        else if (o.type?.endsWith('Link'))
            links.push(o);
    }
    const tablet = [...nodes].find(([, p]) => p['node.name'] === SINK)?.[0];
    if (tablet === undefined)
        return;
    const mon = {};
    for (const [id, p] of ports) {
        if (p['node.id'] === tablet && p['port.direction'] === 'out')
            mon[p['audio.channel']] = id;
    }
    for (const [g, p] of nodes) {
        if (!(p['node.name'] ?? '').startsWith('gnome-remote-desktop') || p['media.class'] !== 'Stream/Input/Audio')
            continue;
        const linked = new Map(links.filter(l => l.info['input-node-id'] === g)
            .map(l => [l.info['input-port-id'], [l.id, l.info['output-node-id']]]));
        for (const [pid, pp] of ports) {
            if (pp['node.id'] !== g || pp['port.direction'] !== 'in')
                continue;
            const cur = linked.get(pid);
            if (cur && cur[1] === tablet)
                continue;
            if (cur)
                await run(['pw-cli', 'destroy', String(cur[0])]);
            if (mon[pp['audio.channel']] !== undefined)
                await run(['pw-link', String(mon[pp['audio.channel']]), String(pid)]);
        }
    }
}
