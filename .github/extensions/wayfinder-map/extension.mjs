import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { discoverLocalMaps, keyForSpec, MapRegistry } from "./maps.mjs";
import { refreshExternalPrompt } from "./prompts.mjs";
import { createMapServer } from "./server.mjs";
import { createSessionControls } from "./sessions.mjs";
import { homeFor, linkSession, linksFor, setHome, unlinkSession } from "./store.mjs";

let resolveSession;
// open() can be rehydrated before joinSession resolves after an app restart.
const sessionReady = new Promise((r) => { resolveSession = r; });
const log = async (message, level = "warning") => (await sessionReady).log(`wayfinder-map: ${message}`, { level, ephemeral: true });

const registry = new MapRegistry({ log });
const sessionControls = createSessionControls({ registry, getSession: () => sessionReady, linkSession, getHome: homeFor, setHome, log });
const server = createMapServer({
    registry,
    onCapabilities: () => sessionControls.capabilities(),
    onListSessions: () => sessionControls.list(),
    onLink: (ctx) => sessionControls.link(ctx),
    onRefresh: async ({ instanceId, key }) => {
        const view = await registry.view(key);
        if (view?.source === "external") {
            await (await sessionReady).send({ prompt: refreshExternalPrompt({ map: view.empty ? { ...view, title: view.ref.key, mapRef: view.ref.key, trackerLabel: "External tracker", ref: { key: view.ref.key } } : view, instanceId }) });
            return { requested: true };
        }
        await registry.refresh(key);
        return { refreshed: true };
    },
    onStart: (ctx) => sessionControls.start(ctx),
    onResume: (ctx) => sessionControls.resume(ctx),
    onGoHome: (ctx) => sessionControls.goHome(ctx),
    onMakeHome: (ctx) => sessionControls.makeHome(ctx),
    onUnlink: async ({ key, ticketId }) => {
        const removed = await unlinkSession(key, ticketId);
        await registry.notifyLinksChanged(key);
        return { removed };
    },
});

const openSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        source: { type: "string", enum: ["local", "github", "external"], description: "Where the map lives. Omit to auto-detect a single local map under ./.scratch." },
        path: { type: "string", description: "local: the effort directory (.scratch/<effort>) or its map.md; absolute or relative to the session cwd." },
        repo: { type: "string", pattern: "^[\\w.-]+/[\\w.-]+$", description: "github: owner/name." },
        map: { type: ["integer", "string"], description: "github: the map issue number (labelled wayfinder:map)." },
        key: { type: "string", minLength: 1, description: "external: stable map key, e.g. \"jira:PROJ-123\". Populate it with the set_map action." },
    },
};

const ticketSchema = {
    type: "object",
    required: ["id", "title", "state"],
    properties: {
        id: { type: "string", description: "Tracker id, e.g. PROJ-124." },
        title: { type: "string" },
        url: { type: "string" },
        type: { type: "string", enum: ["research", "prototype", "grilling", "task"], description: "From the wayfinder:<type> label." },
        state: { type: "string", description: "open, or closed/resolved/done/out-of-scope." },
        assignee: { type: "string", description: "Claim holder, if any. An assignee on an open ticket is a claim." },
        blockedBy: { type: "array", items: { type: "string" }, description: "Ids of tickets that block this one." },
        question: { type: "string" },
        answer: { type: "string", description: "Resolution comment, for closed tickets." },
        outOfScope: { type: "boolean" },
    },
};

const linkedEntry = { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, gist: { type: "string" } } } };

function brief(view) {
    if (!view || view.empty) return { key: view?.key, empty: true, error: view?.error ?? null };
    return {
        key: view.key,
        title: view.title,
        tracker: view.trackerLabel,
        mapRef: view.mapRef,
        destination: view.destination,
        counts: view.counts,
        next: view.nextId,
        fog: view.fog,
        warnings: view.warnings,
        error: view.error,
        home: view.home ?? null,
        tickets: view.tickets.map((t) => ({
            id: t.id, title: t.title, type: t.type, status: t.status, assignee: t.assignee,
            blockedBy: t.blockedBy, openBlockers: t.openBlockers, session: view.links[t.id]?.sessionId ?? null,
        })),
    };
}

function keyOf(instanceId, mapKey) {
    const key = mapKey ?? server.keyFor(instanceId);
    if (!key) throw new CanvasError("not_open", "This canvas instance has no map; reopen it.");
    return key;
}

const canvas = createCanvas({
    id: "wayfinder-map",
    displayName: "Wayfinder Map",
    description: "Visualize a /wayfinder map (decision tickets, blocking, frontier, fog) from GitHub, local Markdown, or any tracker, and start or resume a session per ticket.",
    inputSchema: openSchema,
    actions: [
        {
            name: "get_map",
            description: "Return the map as the canvas sees it: destination, per-ticket status (frontier/claimed/blocked/resolved/out-of-scope), next frontier ticket, fog, and linked sessions.",
            handler: async ({ instanceId }) => brief(await registry.view(keyOf(instanceId))),
        },
        {
            name: "refresh",
            description: "Re-read a GitHub or local map from its tracker. External maps must be re-pushed with set_map.",
            handler: async ({ instanceId }) => {
                const key = keyOf(instanceId);
                if (key.startsWith("external:")) return { note: "External map: read the tracker and call set_map." };
                return brief(await registry.refresh(key));
            },
        },
        {
            name: "set_map",
            description: "Push a map read from another tracker (e.g. Jira via Atlassian MCP) using the project's Wayfinding operations. Pass the map body markdown (Destination/Notes/Decisions so far/Not yet specified/Out of scope) or those fields, plus every child ticket.",
            inputSchema: {
                type: "object",
                required: ["key", "title", "tickets"],
                additionalProperties: false,
                properties: {
                    key: { type: "string", minLength: 1, description: "Stable map key, e.g. \"jira:PROJ-123\"; the same key reopens it." },
                    title: { type: "string" },
                    url: { type: "string" },
                    trackerLabel: { type: "string", description: "e.g. \"Jira\"." },
                    body: { type: "string", description: "Map body markdown; parsed for its sections." },
                    destination: { type: "string" },
                    notes: { type: "string" },
                    decisions: linkedEntry,
                    fog: { type: "array", items: { type: "string" } },
                    outOfScope: linkedEntry,
                    tickets: { type: "array", items: ticketSchema },
                    externalBlockers: { type: "object", additionalProperties: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, open: { type: "boolean" } } } },
                },
            },
            handler: async ({ instanceId, input }) => {
                const key = await registry.setExternal(input);
                if (server.keyFor(instanceId) !== key) return { key, note: `Saved. Open the canvas with {"source":"external","key":${JSON.stringify(input.key)}} to view it.` };
                return brief(await registry.view(key));
            },
        },
        {
            name: "select_ticket",
            description: "Highlight a ticket and show it in the inspector.",
            inputSchema: { type: "object", required: ["ticketId"], additionalProperties: false, properties: { ticketId: { type: "string" } } },
            handler: async ({ instanceId, input }) => {
                await registry.ticket(keyOf(instanceId), input.ticketId);
                return { selected: input.ticketId, delivered: server.select(instanceId, input.ticketId) };
            },
        },
        {
            name: "link_session",
            description: "Record which app session works a ticket, so the canvas can offer Open session. New sessions started from the canvas are linked automatically.",
            inputSchema: {
                type: "object",
                required: ["ticketId", "sessionId"],
                additionalProperties: false,
                properties: { ticketId: { type: "string" }, sessionId: { type: "string", minLength: 1 }, name: { type: "string" }, mapKey: { type: "string", description: "Defaults to this panel's map." } },
            },
            handler: async ({ instanceId, input }) => {
                const key = keyOf(instanceId, input.mapKey);
                await registry.ticket(key, input.ticketId);
                const link = await linkSession(key, input.ticketId, input.sessionId, input.name);
                await registry.notifyLinksChanged(key);
                return { mapKey: key, ticketId: input.ticketId, ...link };
            },
        },
        {
            name: "unlink_session",
            description: "Forget the session linked to a ticket.",
            inputSchema: { type: "object", required: ["ticketId"], additionalProperties: false, properties: { ticketId: { type: "string" }, mapKey: { type: "string" } } },
            handler: async ({ instanceId, input }) => {
                const key = keyOf(instanceId, input.mapKey);
                const removed = await unlinkSession(key, input.ticketId);
                await registry.notifyLinksChanged(key);
                return { removed, links: await linksFor(key) };
            },
        },
    ],
    open: async ({ instanceId, sessionId, input = {} }) => {
        let spec = input;
        if (!spec.source) {
            const found = await discoverLocalMaps();
            if (found.length !== 1) {
                throw new CanvasError("map_required", found.length
                    ? `Several local maps found; pass {"source":"local","path":...}: ${found.join(", ")}`
                    : 'No map given. Pass {"source":"github","repo":"owner/name","map":<n>}, {"source":"local","path":".scratch/<effort>"}, or {"source":"external","key":...}.');
            }
            spec = { source: "local", path: found[0] };
        }
        if (spec.source === "github" && (!spec.repo || spec.map == null)) throw new CanvasError("bad_input", "github maps need repo and map.");
        if (spec.source === "local" && !spec.path) throw new CanvasError("bad_input", "local maps need path.");
        if (spec.source === "external" && !spec.key) throw new CanvasError("bad_input", "external maps need key.");

        let resolved;
        try { resolved = await keyForSpec(spec); } catch (err) { throw new CanvasError(err.code ?? "bad_input", err.message); }
        const prevKey = server.keyFor(instanceId);
        if (prevKey !== resolved.key) {
            await registry.acquire(resolved.key, resolved.spec);
            if (prevKey) { server.detach(instanceId); registry.release(prevKey); }
        }
        const viewer = sessionId ?? (await sessionReady).sessionId;
        const url = await server.attach(instanceId, resolved.key, viewer);
        sessionControls.claimHomeIfUnset({ key: resolved.key, sessionId: viewer }).catch((err) => log(`Could not record the map home: ${err.message}`));
        const view = await registry.view(resolved.key);
        const status = view.empty
            ? (view.error ? "Error" : "Waiting for set_map")
            : `${view.counts.frontier} frontier · ${view.counts.resolved} resolved · ${view.tickets.length} tickets`;
        return { url, title: `Wayfinder · ${view.title ?? resolved.key}`, status };
    },
    onClose: ({ instanceId }) => {
        const key = server.detach(instanceId);
        if (key) registry.release(key);
    },
});

const session = await joinSession({ canvases: [canvas] });
resolveSession(session);
