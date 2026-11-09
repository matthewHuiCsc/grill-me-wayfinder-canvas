// Durable per-user storage, keyed by map identity (never by canvas instanceId):
//   artifacts/links.json            { [mapKey]: { [ticketId]: { sessionId, name, linkedAt } } }
//   artifacts/homes.json            { [mapKey]: { sessionId, name, setAt } }  the session ticket sessions nest under
//   artifacts/maps/<hash>.json      last snapshot per map (authoritative only for agent-pushed maps)

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const ARTIFACTS = join(home, "extensions", "wayfinder-map", "artifacts");
const LINKS = join(ARTIFACTS, "links.json");
const HOMES = join(ARTIFACTS, "homes.json");

async function readJson(path, fallback) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
        if (error.code === "ENOENT") return fallback;
        throw error;
    }
}

async function writeJson(path, value) {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
}

const mapFile = (key) => join(ARTIFACTS, "maps", `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`);

export const saveSnapshot = (snapshot) => writeJson(mapFile(snapshot.key), snapshot);
export const loadSnapshot = (key) => readJson(mapFile(key), null);

let chain = Promise.resolve();
function serialized(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
}

export async function linksFor(mapKey) {
    return (await readJson(LINKS, {}))[mapKey] ?? {};
}

export function linkSession(mapKey, ticketId, sessionId, name) {
    return serialized(async () => {
        const all = await readJson(LINKS, {});
        all[mapKey] ??= {};
        all[mapKey][String(ticketId)] = { sessionId, name: name ?? null, linkedAt: new Date().toISOString() };
        await writeJson(LINKS, all);
        return all[mapKey][String(ticketId)];
    });
}

export async function homeFor(mapKey) {
    return (await readJson(HOMES, {}))[mapKey] ?? null;
}

// Sets the map's home session. With onlyIfUnset, an existing home is kept and returned.
export function setHome(mapKey, sessionId, name, { onlyIfUnset = false } = {}) {
    return serialized(async () => {
        const all = await readJson(HOMES, {});
        if (onlyIfUnset && all[mapKey]) return all[mapKey];
        all[mapKey] = { sessionId, name: name ?? null, setAt: new Date().toISOString() };
        await writeJson(HOMES, all);
        return all[mapKey];
    });
}

export function unlinkSession(mapKey, ticketId) {
    return serialized(async () => {
        const all = await readJson(LINKS, {});
        const had = !!all[mapKey]?.[String(ticketId)];
        if (had) { delete all[mapKey][String(ticketId)]; await writeJson(LINKS, all); }
        return had;
    });
}
