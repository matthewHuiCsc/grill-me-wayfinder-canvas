import { CanvasError } from "@github/copilot-sdk/extension";
import { kickoffPrompt, shortName } from "./prompts.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toolResult(result) {
    if (typeof result === "string") return { text: result, data: null };
    if (!object(result) || result.resultType !== "success") {
        throw new CanvasError("session_tool_failed", result?.error || result?.textResultForLlm || "The app session operation failed.");
    }
    return { text: result.textResultForLlm ?? "", data: result.structuredContent ?? null };
}

function jsonData(result) {
    if (result.data !== null) return result.data;
    if (/^\s*[\[{]/.test(result.text)) return JSON.parse(result.text);
    return null;
}

export function createdSessionId(result, name) {
    const data = jsonData(result);
    const id = object(data) ? data.session_id ?? data.id : null;
    if (typeof id === "string" && id.trim()) return id;
    // The desktop's native create_session tool currently returns this exact text format.
    const match = new RegExp(`Created session '${escapeRegex(name)}' \\(id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\)`, "i").exec(result.text);
    if (match) return match[1];
    throw new CanvasError("session_result_invalid", "The app may have created a session, but returned no recognizable session ID. Check your sessions before retrying.");
}

export function sessionList(result) {
    let data = jsonData(result);
    if (data === null) {
        const match = /^Found \d+ item\(s\):\s*([\s\S]+)$/.exec(result.text.trim());
        if (match) data = JSON.parse(match[1]);
    }
    const items = Array.isArray(data) ? data : object(data) ? data.sessions : null;
    if (!Array.isArray(items)) throw new CanvasError("session_result_invalid", "The app returned an unrecognized session list.");
    return items.filter((item) => object(item) && item.type === "session" && typeof item.id === "string" && item.id.trim())
        .map((item) => ({ id: item.id, name: item.name || item.id }));
}

export function createSessionControls({ registry, getSession, linkSession, getHome, setHome, log }) {
    const starting = new Set();
    let reportedError = null;
    const ticketOf = (view, sessionId) => Object.entries(view?.links ?? {}).find(([, l]) => l.sessionId === sessionId)?.[0] ?? null;

    async function tools() {
        const session = await getSession();
        const metadata = await session.rpc.tools.getCurrentMetadata();
        if (!Array.isArray(metadata.tools)) throw new CanvasError("session_tools_unavailable", "The app session tools are not initialized yet. Refresh and try again.");
        return { session, items: metadata.tools };
    }

    function resolve(items, name) {
        const matches = items.filter((tool) => tool.name === name || tool.mcpToolName === name);
        if (matches.length !== 1) throw new CanvasError("session_tools_unavailable", matches.length
            ? `Several providers offer ${name}; cannot safely choose one.`
            : `This session does not offer the app's ${name} tool.`);
        return matches[0].name;
    }

    async function execute(name, args) {
        const { session, items } = await tools();
        return toolResult(await session.rpc.tools.execute({ name: resolve(items, name), arguments: args }));
    }

    async function nameOf(sessionId) {
        try { return sessionList(await execute("list_sessions_and_chats", {})).find((s) => s.id === sessionId)?.name ?? null; }
        catch { return null; } // the name is cosmetic
    }

    return {
        async capabilities() {
            try {
                const { items } = await tools();
                const has = (name) => items.filter((tool) => tool.name === name || tool.mcpToolName === name).length === 1;
                const result = { canStart: has("create_session"), canOpen: has("navigate_to"), canLink: has("list_sessions_and_chats") };
                result.error = Object.values(result).every(Boolean) ? null : "Some app session tools are unavailable in this conversation.";
                reportedError = null;
                return result;
            } catch (error) {
                const message = `Session controls unavailable: ${error.message}`;
                if (reportedError !== message) {
                    await log(message);
                    reportedError = message;
                }
                return { canStart: false, canOpen: false, canLink: false, error: message };
            }
        },
        async start({ key, ticketId }) {
            const requestKey = JSON.stringify([key, String(ticketId)]);
            if (starting.has(requestKey)) throw new CanvasError("start_in_progress", "A session is already being created for this ticket.");
            starting.add(requestKey);
            try {
                const current = await registry.view(key);
                const view = current?.source === "external" ? current : await registry.refresh(key);
                if (view?.error) throw new CanvasError("tracker_unavailable", "Cannot start work while the tracker is unavailable. Refresh the map and try again.");
                const ticket = view?.tickets?.find((t) => t.id === String(ticketId));
                if (!ticket) throw new CanvasError("ticket_not_found", `Ticket ${ticketId} is not on this map.`);
                if (view.links[ticket.id]) throw new CanvasError("already_linked", "This ticket already has a session; open it instead.");
                if (ticket.status !== "frontier") throw new CanvasError("not_takeable", `Ticket is ${ticket.status}; only open, unblocked, unclaimed tickets can start a session.`);
                // New sessions nest under the session that creates them, so only the map home creates them.
                const actor = (await getSession()).sessionId;
                const home = await getHome(key);
                if (home && home.sessionId !== actor) throw new CanvasError("not_home", "Start ticket sessions from the map home so every ticket session is grouped under it.");
                if (!home) {
                    if (ticketOf(view, actor)) throw new CanvasError("not_home", "This is a ticket session. Open the map from the session that charted it to make that the map home, then start tickets there.");
                    await setHome(key, actor, await nameOf(actor), { onlyIfUnset: true });
                    if ((await getHome(key))?.sessionId !== actor) throw new CanvasError("not_home", "Another session just became the map home. Start this ticket from there.");
                }
                const name = shortName(ticket.title);
                const result = await execute("create_session", { name, kickoff: { mode: "interactive", prompt: kickoffPrompt(view, ticket, registry.specFor?.(key)) } });
                const sessionId = createdSessionId(result, name);
                try {
                    const existing = (await registry.view(key))?.links?.[ticket.id];
                    if (existing && existing.sessionId !== sessionId) throw new Error("A different session was linked while creation was in progress");
                    await linkSession(key, ticket.id, sessionId, name);
                } catch (error) {
                    throw new CanvasError("session_link_failed", `Session ${sessionId} was created, but its link could not be saved: ${error.message}. Link that existing session rather than starting another.`);
                }
                await registry.notifyLinksChanged(key);
                return { created: true, sessionId, name };
            } finally {
                starting.delete(requestKey);
            }
        },
        async resume({ key, ticketId }) {
            const view = await registry.view(key);
            const link = view?.links?.[String(ticketId)];
            if (!link) throw new CanvasError("not_linked", "No session is linked to this ticket.");
            await execute("navigate_to", { id: link.sessionId });
            return { opened: true, sessionId: link.sessionId };
        },
        async goHome({ key }) {
            const home = await getHome(key);
            if (!home) throw new CanvasError("no_home", "This map has no home session yet. Open the map from the session that charted it.");
            await execute("navigate_to", { id: home.sessionId });
            return { opened: true, sessionId: home.sessionId };
        },
        async makeHome({ key }) {
            const actor = (await getSession()).sessionId;
            if (ticketOf(await registry.view(key), actor)) throw new CanvasError("ticket_session", "A ticket session can't be the map home; its ticket sessions would nest under one ticket.");
            const home = await setHome(key, actor, await nameOf(actor));
            await registry.notifyLinksChanged(key);
            return { home };
        },
        // Called when a panel opens: the first non-ticket session to open a map becomes its home.
        async claimHomeIfUnset({ key, sessionId }) {
            if (!sessionId || await getHome(key)) return;
            if (ticketOf(await registry.view(key), sessionId)) return;
            await setHome(key, sessionId, await nameOf(sessionId), { onlyIfUnset: true });
            await registry.notifyLinksChanged(key);
        },
        async list() {
            const session = await getSession();
            return { sessions: sessionList(await execute("list_sessions_and_chats", {})).filter((item) => item.id !== session.sessionId) };
        },
        async link({ key, ticketId, sessionId }) {
            await registry.ticket(key, ticketId);
            const sessions = sessionList(await execute("list_sessions_and_chats", {}));
            const chosen = sessions.find((item) => item.id === sessionId);
            if (!chosen) throw new CanvasError("session_not_found", "That session is no longer available. Reopen the session picker.");
            const existing = (await registry.view(key))?.links?.[String(ticketId)];
            if (existing && existing.sessionId !== sessionId) throw new CanvasError("already_linked", "A different session is already linked. Unlink it before choosing another.");
            const link = await linkSession(key, ticketId, chosen.id, chosen.name);
            await registry.notifyLinksChanged(key);
            return { linked: true, ...link };
        },
    };
}
