// Tracker-agnostic Wayfinder map model: parse the map body and derive ticket status and layout depth.

export const TICKET_TYPES = ["research", "prototype", "grilling", "task"];
const CLOSED_STATES = new Set(["closed", "resolved", "done", "out-of-scope", "out of scope", "wontfix"]);

export function isClosedState(state) {
    return CLOSED_STATES.has(String(state ?? "").trim().toLowerCase());
}

// Split a markdown body into `## Heading` sections (lowercased keys); the first H1 is the title.
export function parseSections(md = "") {
    const sections = {};
    let current = null;
    let title = null;
    for (const line of String(md).split(/\r?\n/)) {
        const h1 = /^#\s+(.+?)\s*$/.exec(line);
        if (h1 && !title && !current) { title = h1[1]; continue; }
        const h2 = /^##\s+(.+?)\s*$/.exec(line);
        if (h2) { current = h2[1].trim().toLowerCase(); sections[current] = []; continue; }
        if (current) sections[current].push(line);
    }
    const out = { title };
    for (const [k, lines] of Object.entries(sections)) out[k] = lines.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    return out;
}

// `- [Title](link): gist` (link optional) → entries.
export function parseLinkedList(text = "") {
    const items = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const m = /^\s*[-*]\s+(.*)$/.exec(raw);
        if (!m || !m[1].trim()) continue;
        const body = m[1].trim();
        const link = /^\[([^\]]+)\]\(([^)]+)\)\s*[:\-–—]?\s*(.*)$/.exec(body);
        items.push(link ? { title: link[1], url: link[2], gist: link[3] } : { title: null, url: null, gist: body });
    }
    return items;
}

// Fog is written loosely: each top-level bullet is one patch, otherwise each paragraph.
export function parseFog(text = "") {
    const t = String(text).trim();
    if (!t) return [];
    const bullets = [];
    for (const line of t.split(/\r?\n/)) {
        const m = /^[-*]\s+(.*)$/.exec(line);
        if (m) bullets.push(m[1].trim());
        else if (bullets.length && /^\s+\S/.test(line)) bullets[bullets.length - 1] += " " + line.trim();
    }
    if (bullets.length) return bullets.filter(Boolean);
    return t.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function mapSectionsFromBody(body) {
    const s = parseSections(body);
    return {
        bodyTitle: s.title ?? null,
        destination: s["destination"] ?? "",
        notes: s["notes"] ?? "",
        decisions: parseLinkedList(s["decisions so far"]),
        fog: parseFog(s["not yet specified"]),
        outOfScope: parseLinkedList(s["out of scope"]),
    };
}

export function hitlFor(type) {
    if (type === "research") return "AFK";
    if (type === "prototype" || type === "grilling") return "HITL";
    if (type === "task") return "HITL or AFK";
    return "unknown";
}

/**
 * Derive per-ticket status from a normalized snapshot:
 *   resolved | out-of-scope | claimed | blocked | frontier
 * Unblocked = every blocker closed; frontier = open, unblocked, unclaimed (Wayfinder's definition).
 */
export function deriveMap(snapshot) {
    const tickets = snapshot.tickets ?? [];
    const byId = new Map(tickets.map((t) => [String(t.id), t]));
    const external = snapshot.externalBlockers ?? {};
    const blockerOpen = (id) => {
        const sib = byId.get(id);
        if (sib) return !isClosedState(sib.state);
        const ext = external[id];
        return ext ? !!ext.open : true; // unknown blocker: assume it still blocks
    };

    const derived = tickets.map((t, order) => {
        const blockedBy = (t.blockedBy ?? []).map(String);
        const openBlockers = blockedBy.filter(blockerOpen);
        let status;
        if (isClosedState(t.state)) status = t.outOfScope ? "out-of-scope" : "resolved";
        else if (t.claimed) status = "claimed";
        else if (openBlockers.length) status = "blocked";
        else status = "frontier";
        return {
            ...t,
            id: String(t.id),
            order,
            blockedBy,
            openBlockers,
            unknownBlockers: blockedBy.filter((id) => !byId.has(id) && !external[id]),
            blocks: [],
            status,
            hitl: hitlFor(t.type),
        };
    });
    const dById = new Map(derived.map((t) => [t.id, t]));
    for (const t of derived) for (const b of t.blockedBy) dById.get(b)?.blocks.push(t.id);

    // Depth = longest blocking chain back to a root (cycle-safe).
    const depth = new Map();
    const visiting = new Set();
    const depthOf = (id) => {
        if (depth.has(id)) return depth.get(id);
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let d = 0;
        for (const b of dById.get(id)?.blockedBy ?? []) if (dById.has(b)) d = Math.max(d, depthOf(b) + 1);
        visiting.delete(id);
        depth.set(id, d);
        return d;
    };
    for (const t of derived) t.depth = depthOf(t.id);

    const next = derived.find((t) => t.status === "frontier");
    if (next) next.next = true;

    const counts = { frontier: 0, claimed: 0, blocked: 0, resolved: 0, "out-of-scope": 0 };
    for (const t of derived) counts[t.status]++;

    return {
        ...snapshot,
        tickets: derived,
        counts,
        nextId: next?.id ?? null,
        clear: derived.length > 0 && derived.every((t) => isClosedState(t.state)) && !(snapshot.fog ?? []).length,
    };
}
