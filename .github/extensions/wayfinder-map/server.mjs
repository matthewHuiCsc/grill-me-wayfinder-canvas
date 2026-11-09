// One loopback server shared by all panels. Each panel gets a random token so other local pages
// can't drive session controls (which post prompts into the user's session).

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 64 * 1024;

export function createMapServer({ registry, onStart, onResume, onUnlink, onRefresh, onCapabilities, onListSessions, onLink, onGoHome, onMakeHome }) {
    const panels = new Map(); // instanceId -> { key, viewer (session hosting the panel), token, unsubscribe, clients:Set<res> }
    let listening = null;

    async function base() {
        listening ??= new Promise((resolveP, reject) => {
            const server = createServer((req, res) => handle(req, res).catch((err) => fail(res, 500, err)));
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => resolveP(`http://127.0.0.1:${server.address().port}`));
        });
        return listening;
    }

    function fail(res, status, err) {
        if (res.headersSent) return res.end();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: err?.code ?? "error", message: String(err?.message ?? err) } }));
    }

    function json(res, value) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(value));
    }

    async function body(req) {
        let size = 0;
        const chunks = [];
        for await (const c of req) {
            size += c.length;
            if (size > BODY_LIMIT) throw Object.assign(new Error("Body too large"), { code: "too_large" });
            chunks.push(c);
        }
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    }

    async function handle(req, res) {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === "/" || url.pathname === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(await readFile(join(here, "ui.html"), "utf8"));
        }
        const panel = panels.get(url.searchParams.get("i") ?? "");
        if (!panel || url.searchParams.get("t") !== panel.token) return fail(res, 403, { code: "forbidden", message: "Unknown panel or token; reopen the canvas." });
        const write = req.method === "POST";

        if (url.pathname === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
            res.write("retry: 2000\n\n");
            panel.clients.add(res);
            req.on("close", () => panel.clients.delete(res));
            return;
        }
        if (url.pathname === "/api/state" && !write) return json(res, { ...((await registry.view(panel.key)) ?? { empty: true }), sessionControls: await onCapabilities(), viewerSessionId: panel.viewer ?? null });
        if (url.pathname === "/api/ticket" && !write) return json(res, (await registry.ticket(panel.key, url.searchParams.get("id"))).ticket);
        if (url.pathname === "/api/sessions" && !write) return json(res, await onListSessions());
        if (!write) return fail(res, 404, { code: "not_found", message: url.pathname });

        const input = await body(req);
        const ctx = { instanceId: url.searchParams.get("i"), key: panel.key, ticketId: input.id };
        if (url.pathname === "/api/refresh") return json(res, await onRefresh(ctx));
        if (url.pathname === "/api/start") return json(res, await onStart(ctx));
        if (url.pathname === "/api/resume") return json(res, await onResume(ctx));
        if (url.pathname === "/api/unlink") return json(res, await onUnlink(ctx));
        if (url.pathname === "/api/link") return json(res, await onLink({ ...ctx, sessionId: input.sessionId }));
        if (url.pathname === "/api/home" && onGoHome) return json(res, await onGoHome(ctx));
        if (url.pathname === "/api/make-home" && onMakeHome) return json(res, await onMakeHome(ctx));
        return fail(res, 404, { code: "not_found", message: url.pathname });
    }

    function push(instanceId) {
        const p = panels.get(instanceId);
        for (const res of p?.clients ?? []) res.write("event: changed\ndata: {}\n\n");
    }

    return {
        async attach(instanceId, key, viewer) {
            const prev = panels.get(instanceId);
            if (prev?.key === key) {
                if (viewer && prev.viewer !== viewer) { prev.viewer = viewer; push(instanceId); }
                return `${await base()}/?i=${encodeURIComponent(instanceId)}&t=${prev.token}`;
            }
            if (prev) this.detach(instanceId);
            const panel = { key, viewer, token: randomBytes(18).toString("base64url"), clients: new Set() };
            panel.unsubscribe = registry.subscribe(key, () => push(instanceId));
            panels.set(instanceId, panel);
            return `${await base()}/?i=${encodeURIComponent(instanceId)}&t=${panel.token}`;
        },
        detach(instanceId) {
            const p = panels.get(instanceId);
            if (!p) return null;
            p.unsubscribe?.();
            for (const res of p.clients) res.end();
            panels.delete(instanceId);
            return p.key;
        },
        keyFor: (instanceId) => panels.get(instanceId)?.key ?? null,
        select(instanceId, ticketId) {
            const p = panels.get(instanceId);
            for (const res of p?.clients ?? []) res.write(`event: select\ndata: ${JSON.stringify({ id: ticketId })}\n\n`);
            return !!p?.clients.size;
        },
    };
}
