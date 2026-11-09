// Tracker adapters. Each returns a normalized snapshot:
// { key, source, ref, title, url, destination, notes, decisions, fog, outOfScope,
//   tickets: [{ id, title, url, type, state, claimed, assignee, blockedBy, question, answer, outOfScope }],
//   externalBlockers, warnings, fetchedAt }
// The tracker stays authoritative; snapshots are a read-only projection.

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { TICKET_TYPES, isClosedState, mapSectionsFromBody, parseSections } from "./model.mjs";

// ---------- Local Markdown (.scratch/<effort>/map.md + issues/NN-<slug>.md) ----------

export async function resolveLocalMapDir(path, cwd = process.cwd()) {
    let dir = isAbsolute(path) ? path : resolve(cwd, path);
    if (basename(dir).toLowerCase() === "map.md") dir = resolve(dir, "..");
    const s = await stat(join(dir, "map.md")).catch(() => null);
    if (!s?.isFile()) throw Object.assign(new Error(`No map.md found in ${dir}`), { code: "map_not_found" });
    return dir;
}

function headerLine(md, name) {
    const m = new RegExp(`^\\s*\\**${name}\\**\\s*:\\s*(.+?)\\s*$`, "im").exec(md);
    return m ? m[1].trim() : null;
}

const numId = (s) => String(Number.parseInt(s, 10));

export function parseLocalTicket(file, md) {
    const idMatch = /^(\d+)/.exec(file);
    const id = idMatch ? numId(idMatch[1]) : file.replace(/\.md$/, "");
    const sections = parseSections(md);
    const status = (headerLine(md, "Status") ?? "open").toLowerCase();
    const typeRaw = (headerLine(md, "Type") ?? "").toLowerCase();
    const blockedRaw = headerLine(md, "Blocked by");
    const blockedBy = blockedRaw && !/^(none|-|n\/a)$/i.test(blockedRaw)
        ? [...blockedRaw.matchAll(/(\d+)/g)].map((m) => numId(m[1]))
        : [];
    const slug = file.replace(/\.md$/, "").replace(/^\d+-?/, "").replace(/[-_]+/g, " ").trim();
    return {
        id,
        file,
        title: sections.title ?? (slug ? slug[0].toUpperCase() + slug.slice(1) : file),
        type: TICKET_TYPES.includes(typeRaw) ? typeRaw : typeRaw || null,
        state: isClosedState(status) ? "closed" : "open",
        rawStatus: status,
        claimed: status === "claimed",
        assignee: headerLine(md, "Assignee") ?? (status === "claimed" ? "claimed" : null),
        blockedBy,
        question: sections["question"] ?? "",
        answer: sections["answer"] ?? "",
        outOfScope: /out[- ]of[- ]scope/.test(status),
    };
}

export async function loadLocal(path, cwd) {
    const dir = await resolveLocalMapDir(path, cwd);
    const mapMd = await readFile(join(dir, "map.md"), "utf8");
    const sections = mapSectionsFromBody(mapMd);
    const issuesDir = join(dir, "issues");
    const files = (await readdir(issuesDir).catch(() => []))
        .filter((f) => f.endsWith(".md"))
        .sort((a, b) => (Number.parseInt(a, 10) || 0) - (Number.parseInt(b, 10) || 0) || a.localeCompare(b));
    const tickets = [];
    for (const file of files) {
        const md = await readFile(join(issuesDir, file), "utf8");
        const t = parseLocalTicket(file, md);
        t.url = join(issuesDir, file);
        tickets.push(t);
    }
    markOutOfScope(tickets, sections.outOfScope, (t, ref) => ref.includes(t.file));
    return {
        key: `local:${dir}`,
        source: "local",
        trackerLabel: "Local Markdown",
        ref: { path: dir },
        mapRef: join(dir, "map.md"),
        title: sections.bodyTitle ?? basename(dir),
        url: join(dir, "map.md"),
        ...sections,
        tickets,
        externalBlockers: {},
        warnings: [],
        watchDir: dir,
        fetchedAt: new Date().toISOString(),
    };
}

function markOutOfScope(tickets, outOfScope, matches) {
    for (const entry of outOfScope) {
        const ref = `${entry.url ?? ""} ${entry.title ?? ""} ${entry.gist ?? ""}`;
        for (const t of tickets) if (isClosedState(t.state) && matches(t, ref)) t.outOfScope = true;
    }
}

// ---------- GitHub Issues (sub-issues + native dependencies, via `gh`) ----------

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function makeGh(bin = process.env.WAYFINDER_GH || "gh") {
    const env = { ...process.env, PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(":"), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
    return (args) => new Promise((resolveP, reject) => {
        execFile(bin, args, { env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error((stderr || err.message).trim().split("\n").slice(-3).join(" "));
                e.code = err.code === "ENOENT" ? "gh_missing" : "gh_failed";
                e.notFound = /HTTP 404|Not Found/i.test(stderr);
                return reject(e);
            }
            resolveP(stdout);
        });
    });
}

async function ghJson(gh, path, paginate = false) {
    const out = await gh(["api", ...(paginate ? ["--paginate", "--slurp"] : []), "-H", "Accept: application/vnd.github+json", path]);
    const data = JSON.parse(out || "null");
    return paginate && Array.isArray(data) ? data.flat() : data;
}

async function pool(items, size, fn) {
    const results = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); }
    }));
    return results;
}

function ghTicket(issue) {
    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
    const typeLabel = labels.find((l) => /^wayfinder:/.test(l) && l !== "wayfinder:map");
    const assignees = (issue.assignees ?? []).map((a) => a.login);
    const sections = parseSections(issue.body ?? "");
    return {
        id: `#${issue.number}`,
        number: issue.number,
        dbId: issue.id,
        title: issue.title,
        url: issue.html_url,
        type: typeLabel ? typeLabel.slice("wayfinder:".length) : null,
        state: issue.state === "closed" ? "closed" : "open",
        stateReason: issue.state_reason ?? null,
        claimed: issue.state !== "closed" && assignees.length > 0,
        assignee: assignees.join(", ") || null,
        blockedBy: [],
        question: sections["question"] ?? (issue.body ?? "").trim(),
        answer: "",
        outOfScope: false,
    };
}

export async function loadGithub({ repo, map }, gh = makeGh()) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw Object.assign(new Error("repo must be owner/name"), { code: "bad_input" });
    const n = Number.parseInt(String(map).replace(/^#/, ""), 10);
    if (!Number.isFinite(n)) throw Object.assign(new Error("map must be an issue number"), { code: "bad_input" });
    const base = `repos/${repo}/issues`;
    const warnings = [];
    const mapIssue = await ghJson(gh, `${base}/${n}`);
    const sections = mapSectionsFromBody(mapIssue.body ?? "");

    let children = [];
    try {
        children = await ghJson(gh, `${base}/${n}/sub_issues?per_page=100`, true);
    } catch (err) {
        if (!err.notFound) throw err;
        warnings.push("Sub-issues unavailable; reading the map's task list instead.");
    }
    if (!children.length) {
        const refs = [...new Set([...(mapIssue.body ?? "").matchAll(/^\s*[-*]\s+\[[ xX]\]\s+.*?#(\d+)/gm)].map((m) => Number(m[1])))];
        children = (await pool(refs, 6, (k) => ghJson(gh, `${base}/${k}`).catch(() => null))).filter(Boolean);
    }
    const tickets = children.map(ghTicket);
    const external = {};
    let fallbackBlocking = false;
    await pool(tickets, 6, async (t, k) => {
        try {
            const blockers = await ghJson(gh, `${base}/${t.number}/dependencies/blocked_by?per_page=100`, true);
            t.blockedBy = blockers.map((b) => `#${b.number}`);
            for (const b of blockers) external[`#${b.number}`] = { title: b.title, url: b.html_url, open: b.state !== "closed" };
        } catch (err) {
            if (!err.notFound) throw err;
            fallbackBlocking = true;
            const line = /^\s*\**Blocked by\**\s*:\s*(.+)$/im.exec(children[k].body ?? "");
            t.blockedBy = line ? [...line[1].matchAll(/#(\d+)/g)].map((m) => `#${m[1]}`) : [];
        }
    });
    if (fallbackBlocking) warnings.push("Native issue dependencies unavailable for some tickets; used `Blocked by:` lines.");
    const ids = new Set(tickets.map((t) => t.id));
    for (const id of Object.keys(external)) if (ids.has(id)) delete external[id];
    markOutOfScope(tickets, sections.outOfScope, (t, ref) => new RegExp(`(#|/issues/)${t.number}(?!\\d)`).test(ref));

    return {
        key: `github:${repo}#${n}`,
        source: "github",
        trackerLabel: "GitHub Issues",
        ref: { repo, map: n },
        mapRef: mapIssue.html_url,
        title: mapIssue.title,
        url: mapIssue.html_url,
        ...sections,
        tickets,
        externalBlockers: external,
        warnings,
        fetchedAt: new Date().toISOString(),
    };
}

// Resolution comment for a closed GitHub ticket, fetched on demand.
export async function loadGithubAnswer({ repo }, number, gh = makeGh()) {
    const comments = await ghJson(gh, `repos/${repo}/issues/${number}/comments?per_page=100`, true);
    return comments.length ? comments[comments.length - 1].body ?? "" : "";
}

// ---------- External trackers (Jira via Atlassian MCP, GitLab, anything else) ----------
// The agent reads the tracker with whatever tools the project's "Wayfinding operations" describe,
// then pushes this normalized shape via the `set_map` action.

export function normalizeExternal(input) {
    const sections = input.body ? mapSectionsFromBody(input.body) : {};
    const pick = (k, fallback) => input[k] ?? sections[k] ?? fallback;
    const tickets = (input.tickets ?? []).map((t) => ({
        id: String(t.id),
        title: t.title,
        url: t.url ?? null,
        type: t.type ?? null,
        state: isClosedState(t.state) ? "closed" : "open",
        claimed: !isClosedState(t.state) && !!(t.assignee || t.claimed),
        assignee: t.assignee ?? null,
        blockedBy: (t.blockedBy ?? []).map(String),
        question: t.question ?? "",
        answer: t.answer ?? "",
        outOfScope: !!t.outOfScope,
    }));
    return {
        key: `external:${input.key}`,
        source: "external",
        trackerLabel: input.trackerLabel ?? "External tracker",
        ref: { key: input.key },
        mapRef: input.url ?? input.key,
        title: input.title ?? sections.bodyTitle ?? input.key,
        url: input.url ?? null,
        destination: pick("destination", ""),
        notes: pick("notes", ""),
        decisions: pick("decisions", []),
        fog: pick("fog", []),
        outOfScope: pick("outOfScope", []),
        tickets,
        externalBlockers: input.externalBlockers ?? {},
        warnings: ["Pushed by the agent from the project's tracker; refresh asks the agent to re-read it."],
        fetchedAt: new Date().toISOString(),
    };
}
