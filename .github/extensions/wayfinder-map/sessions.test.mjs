import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionControls, createdSessionId, sessionList } from "./sessions.mjs";
import { deriveMap } from "./model.mjs";
import { createMapServer } from "./server.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
let passed = 0;
async function check(name, fn) { await fn(); passed++; process.stderr.write(`PASS ${name}\n`); }
function fixture() {
    const snapshot = { key: "local:test", source: "local", title: "Test map", mapRef: "/test/map.md", ref: { path: "/test" }, fog: [], destination: "Decide", tickets: [
        { id: "1", title: "First decision", type: "grilling", state: "open", blockedBy: [], question: "Question?" },
        { id: "2", title: "Later decision", type: "prototype", state: "open", blockedBy: ["1"] },
    ] };
    const links = {}, calls = [], logs = [];
    let home = null, actor = "current";
    let error = null, handler = async ({ name, arguments: args }) => {
        if (name === "create_session") return { resultType: "success", textResultForLlm: `Created session '${args.name}' (id: ${ID}) in project 'Test' with a kickoff prompt.` };
        if (name === "list_sessions_and_chats") return { resultType: "success", textResultForLlm: `Found 2 item(s):\n${JSON.stringify([{ type: "session", id: ID, name: "Existing" }, { type: "chat", id: "chat", name: "Not a session" }])}` };
        return { resultType: "success", textResultForLlm: "Navigated." };
    };
    let metadata = ["create_session", "navigate_to", "list_sessions_and_chats"].map((name) => ({ name }));
    const registry = {
        view: async () => ({ ...deriveMap(snapshot), links, error }),
        refresh: async () => registry.view(),
        ticket: async (_, id) => {
            const map = await registry.view();
            const ticket = map.tickets.find((t) => t.id === id);
            if (!ticket) throw new Error("Ticket missing");
            return { map, ticket };
        },
        notifyLinksChanged: async () => {},
        subscribe: () => () => {},
    };
    const controls = createSessionControls({
        registry, log: async (message) => logs.push(message),
        getSession: async () => ({ sessionId: actor, rpc: { tools: {
            getCurrentMetadata: async () => ({ tools: metadata }),
            execute: async (request) => { calls.push(request); return handler(request); },
        } } }),
        linkSession: async (_, id, sessionId, name) => { links[id] = { sessionId, name }; return links[id]; },
        getHome: async () => home,
        setHome: async (_, sessionId, name, { onlyIfUnset } = {}) => { if (!(onlyIfUnset && home)) home = { sessionId, name }; return home; },
    });
    return { controls, getHome: () => home, setHomeValue: (value) => { home = value; }, setActor: (value) => { actor = value; }, registry, snapshot, links, calls, logs, setError: (value) => { error = value; }, setHandler: (value) => { handler = value; }, setMetadata: (value) => { metadata = value; } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

try {
    await check("native result parsers handle structured and observed desktop text", async () => {
        assert.equal(createdSessionId({ data: { session_id: ID }, text: "" }, "Name"), ID);
        const name = "A 'quoted' name [test]";
        assert.equal(createdSessionId({ data: null, text: `Created session '${name}' (id: ${ID}) in project 'Test'.` }, name), ID);
        assert.throws(() => createdSessionId({ data: null, text: "No known ID" }, name), (e) => e.code === "session_result_invalid");
        assert.deepEqual(sessionList({ data: null, text: 'Found 1 item(s):\n[{"type":"session","id":"real","name":"Real"}]' }), [{ id: "real", name: "Real" }]);
        assert.throws(() => sessionList({ data: null, text: "Unavailable" }));
    });
    await check("start creates an interactive one-ticket session and saves its returned ID", async () => {
        const f = fixture();
        const result = await f.controls.start({ key: f.snapshot.key, ticketId: "1" });
        assert.equal(result.sessionId, ID);
        assert.equal(f.links["1"].sessionId, ID);
        const create = f.calls.find((c) => c.name === "create_session");
        assert.equal(create.arguments.kickoff.mode, "interactive");
        assert.match(create.arguments.kickoff.prompt, /\/wayfinder "\/test\/map.md"/);
        assert.match(create.arguments.kickoff.prompt, /only this ticket/);
        assert.match(create.arguments.kickoff.prompt, /claim it as your first write/);
        assert.equal(f.getHome().sessionId, "current", "the first session to start a ticket becomes the map home");
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "already_linked");
    });
    await check("blocked, claimed, resolved, missing and stale tickets cannot start", async () => {
        const f = fixture();
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "2" }), "not_takeable");
        f.snapshot.tickets[0].claimed = true;
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "not_takeable");
        f.snapshot.tickets[0].state = "closed";
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "not_takeable");
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "99" }), "ticket_not_found");
        f.setError({ message: "Tracker offline" });
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "tracker_unavailable");
        assert.equal(f.calls.length, 0);
    });
    await check("concurrent duplicate start requests create only one session", async () => {
        const f = fixture();
        let release;
        const wait = new Promise((resolve) => { release = resolve; });
        f.setHandler(async () => { await wait; return { resultType: "success", structuredContent: { id: ID }, textResultForLlm: "" }; });
        const first = f.controls.start({ key: f.snapshot.key, ticketId: "1" });
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "start_in_progress");
        release();
        await first;
        assert.equal(f.calls.filter((c) => c.name === "create_session").length, 1);
    });
    await check("permission denial is surfaced and a failed request releases its guard", async () => {
        const f = fixture();
        f.setHandler(async () => ({ resultType: "denied", textResultForLlm: "Permission denied" }));
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "session_tool_failed");
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "session_tool_failed");
        assert.equal(f.calls.filter((c) => c.name === "create_session").length, 2);
        assert.deepEqual(f.links, {});
    });
    await check("a link conflict does not overwrite another session or report false success", async () => {
        const f = fixture();
        f.setHandler(async () => {
            f.links["1"] = { sessionId: "other-session", name: "Other" };
            return { resultType: "success", structuredContent: { id: ID }, textResultForLlm: "" };
        });
        await assert.rejects(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), (error) => error.code === "session_link_failed" && error.message.includes(ID));
        assert.equal(f.links["1"].sessionId, "other-session");
    });
    await check("opening uses the stored session ID and linking requires an actual listed session", async () => {
        const f = fixture();
        await rejectsCode(f.controls.resume({ key: f.snapshot.key, ticketId: "1" }), "not_linked");
        await f.controls.link({ key: f.snapshot.key, ticketId: "1", sessionId: ID });
        await f.controls.resume({ key: f.snapshot.key, ticketId: "1" });
        assert.deepEqual(f.calls.at(-1), { name: "navigate_to", arguments: { id: ID } });
        await rejectsCode(f.controls.link({ key: f.snapshot.key, ticketId: "2", sessionId: "invented" }), "session_not_found");
        assert.deepEqual((await f.controls.list()).sessions, [{ id: ID, name: "Existing" }]);
    });
    await check("only the map home starts ticket sessions, so they nest under it", async () => {
        const f = fixture();
        f.setHomeValue({ sessionId: "home", name: "Home" });
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "not_home");
        assert.equal(f.calls.filter((c) => c.name === "create_session").length, 0);
        await f.controls.goHome({ key: f.snapshot.key });
        assert.deepEqual(f.calls.at(-1), { name: "navigate_to", arguments: { id: "home" } });
        f.setActor("home");
        assert.equal((await f.controls.start({ key: f.snapshot.key, ticketId: "1" })).created, true);
    });
    await check("ticket sessions never become the map home", async () => {
        const f = fixture();
        f.links["1"] = { sessionId: "current", name: "Ticket 1" };
        await f.controls.claimHomeIfUnset({ key: f.snapshot.key, sessionId: "current" });
        assert.equal(f.getHome(), null);
        await rejectsCode(f.controls.makeHome({ key: f.snapshot.key }), "ticket_session");
        await rejectsCode(f.controls.goHome({ key: f.snapshot.key }), "no_home");
        await f.controls.claimHomeIfUnset({ key: f.snapshot.key, sessionId: "charting" });
        assert.equal(f.getHome().sessionId, "charting");
        await f.controls.claimHomeIfUnset({ key: f.snapshot.key, sessionId: "later" });
        assert.equal(f.getHome().sessionId, "charting", "an existing home is kept");
    });
    await check("missing or ambiguous native tools disable controls instead of guessing", async () => {
        const f = fixture();
        f.setMetadata([]);
        assert.equal((await f.controls.capabilities()).canStart, false);
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "session_tools_unavailable");
        f.setMetadata([{ name: "one", mcpToolName: "create_session" }, { name: "two", mcpToolName: "create_session" }]);
        await rejectsCode(f.controls.start({ key: f.snapshot.key, ticketId: "1" }), "session_tools_unavailable");
        assert.equal(f.calls.length, 0);
        f.setMetadata(null);
        assert.match((await f.controls.capabilities()).error, /not initialized/);
        assert.equal(f.logs.length, 1);
    });
    await check("HTTP session endpoints preserve authentication and return real outcomes", async () => {
        const f = fixture();
        const server = createMapServer({ registry: f.registry,
            onCapabilities: () => f.controls.capabilities(), onListSessions: () => f.controls.list(),
            onLink: (ctx) => f.controls.link(ctx), onStart: (ctx) => f.controls.start(ctx), onResume: (ctx) => f.controls.resume(ctx),
            onRefresh: async () => ({ refreshed: true }), onUnlink: async () => ({ removed: false }),
        });
        const url = new URL(await server.attach("test-panel", f.snapshot.key));
        const api = (path) => new URL(`${path}${url.search}`, url);
        assert.equal((await fetch(new URL("/api/sessions", url))).status, 403);
        const state = await (await fetch(api("/api/state"))).json();
        assert.equal(state.sessionControls.canStart, true);
        assert.equal((await (await fetch(api("/api/sessions"))).json()).sessions[0].id, ID);
        const post = (path, data) => fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
        assert.equal((await (await post("/api/start", { id: "2" })).json()).error.code, "not_takeable");
        assert.equal((await (await post("/api/start", { id: "1" })).json()).created, true);
        assert.equal((await (await post("/api/resume", { id: "1" })).json()).opened, true);
        server.detach("test-panel");
    });
    await check("session links persist and corrupted storage is not silently emptied", async () => {
        const home = await mkdtemp(join(tmpdir(), "wayfinder-storage-test-"));
        const original = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = home;
        try {
            const store = await import(`./store.mjs?test=${Date.now()}`);
            await store.linkSession("map", "1", ID, "Saved");
            assert.equal((await store.linksFor("map"))["1"].sessionId, ID);
            await writeFile(join(store.ARTIFACTS, "links.json"), "{corrupt");
            await assert.rejects(store.linksFor("map"), SyntaxError);
        } finally {
            if (original === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = original;
            await rm(home, { recursive: true });
        }
    });
    await check("renderer script parses", async () => {
        const html = await readFile(new URL("./ui.html", import.meta.url), "utf8");
        new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    });
    process.stderr.write(`${passed} checks passed.\n`);
    process.exit(0);
} catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
}
