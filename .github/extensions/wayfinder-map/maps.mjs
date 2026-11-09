// Map registry: one live projection per map key, shared by every panel showing that map.

import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadGithub, loadGithubAnswer, loadLocal, makeGh, normalizeExternal, resolveLocalMapDir } from "./adapters.mjs";
import { deriveMap } from "./model.mjs";
import { homeFor, linksFor, loadSnapshot, saveSnapshot } from "./store.mjs";

const GITHUB_POLL_MS = 120_000;

export async function discoverLocalMaps(cwd = process.cwd()) {
    const root = join(cwd, ".scratch");
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        if ((await stat(join(root, d.name, "map.md")).catch(() => null))?.isFile()) found.push(join(root, d.name));
    }
    return found;
}

export async function keyForSpec(spec, cwd) {
    switch (spec.source) {
        case "local": return { key: `local:${await resolveLocalMapDir(spec.path, cwd)}`, spec: { ...spec, path: await resolveLocalMapDir(spec.path, cwd) } };
        case "github": return { key: `github:${spec.repo}#${Number.parseInt(String(spec.map).replace(/^#/, ""), 10)}`, spec };
        case "external": return { key: `external:${spec.key}`, spec };
        default: throw Object.assign(new Error(`Unknown source ${spec.source}`), { code: "bad_input" });
    }
}

export class MapRegistry {
    constructor({ gh = makeGh(), log = () => {} } = {}) {
        this.gh = gh;
        this.log = log;
        this.entries = new Map();
    }

    entry(key, spec) {
        let e = this.entries.get(key);
        if (!e) {
            e = { key, spec, snapshot: null, error: null, loading: null, listeners: new Set(), refs: 0, watcher: null, timer: null };
            this.entries.set(key, e);
        }
        if (spec) e.spec = spec;
        return e;
    }

    async acquire(key, spec) {
        const e = this.entry(key, spec);
        e.refs++;
        if (!e.snapshot) await this.refresh(key);
        this.startLive(e);
        return e;
    }

    release(key) {
        const e = this.entries.get(key);
        if (!e || --e.refs > 0) return;
        e.watcher?.close();
        clearInterval(e.timer);
        e.watcher = e.timer = null;
    }

    startLive(e) {
        if (e.spec.source === "local" && !e.watcher) {
            let t;
            try {
                e.watcher = watch(e.spec.path, { recursive: true }, () => {
                    clearTimeout(t);
                    t = setTimeout(() => this.refresh(e.key).catch(() => {}), 250);
                });
                e.watcher.on("error", () => { e.watcher?.close(); e.watcher = null; });
            } catch { /* fs.watch unsupported: manual refresh still works */ }
        }
        if (e.spec.source === "github" && !e.timer) {
            e.timer = setInterval(() => this.refresh(e.key).catch(() => {}), GITHUB_POLL_MS);
            e.timer.unref?.();
        }
    }

    async refresh(key) {
        const e = this.entries.get(key);
        if (!e) throw Object.assign(new Error("Map is not open"), { code: "map_not_open" });
        e.loading ??= (async () => {
            try {
                const { spec } = e;
                let snap;
                if (spec.source === "local") snap = await loadLocal(spec.path);
                else if (spec.source === "github") snap = await loadGithub(spec, this.gh);
                else snap = (await loadSnapshot(key)) ?? null;
                if (snap && spec.source !== "external") await saveSnapshot(snap).catch(() => {});
                e.snapshot = snap;
                e.error = null;
            } catch (err) {
                e.error = { code: err.code ?? "load_failed", message: String(err.message ?? err) };
                // Keep showing the last good projection, flagged as stale, rather than an empty map.
                e.snapshot ??= await loadSnapshot(key).catch(() => null);
            } finally {
                e.loading = null;
            }
            this.emit(e);
        })();
        await e.loading;
        return this.view(key);
    }

    async setExternal(input) {
        const snap = normalizeExternal(input);
        await saveSnapshot(snap);
        const e = this.entry(snap.key, { source: "external", key: input.key });
        e.snapshot = snap;
        e.error = null;
        this.emit(e);
        return snap.key;
    }

    specFor(key) { return this.entries.get(key)?.spec ?? null; }

    async view(key) {
        const e = this.entries.get(key);
        if (!e) return null;
        const links = await linksFor(key);
        const home = await homeFor(key);
        if (!e.snapshot) return { key, source: e.spec.source, ref: e.spec, empty: true, error: e.error, links, home };
        const derived = deriveMap(e.snapshot);
        delete derived.watchDir;
        return { ...derived, error: e.error, stale: !!e.error, links, home };
    }

    async ticket(key, id) {
        const v = await this.view(key);
        const t = v?.tickets?.find((x) => x.id === String(id));
        if (!t) throw Object.assign(new Error(`Ticket ${id} not found on this map`), { code: "ticket_not_found" });
        if (v.source === "github" && t.state === "closed" && !t.answer) {
            t.answer = await loadGithubAnswer(v.ref, t.number, this.gh).catch((err) => `(Could not load resolution comment: ${err.message})`);
            const snapT = this.entries.get(key).snapshot.tickets.find((x) => String(x.id) === t.id);
            if (snapT) snapT.answer = t.answer;
        }
        return { map: v, ticket: t };
    }

    subscribe(key, fn) {
        const e = this.entries.get(key);
        e?.listeners.add(fn);
        return () => e?.listeners.delete(fn);
    }

    emit(e) {
        for (const fn of e.listeners) { try { fn(); } catch { /* listener gone */ } }
    }

    async notifyLinksChanged(key) {
        const e = this.entries.get(key);
        if (e) this.emit(e);
    }
}
