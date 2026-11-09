import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(root, ".github", "extensions", "wayfinder-map");
const sourceFiles = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

function install(home) {
    return spawnSync("sh", [join(root, "install.sh")], {
        env: { ...process.env, COPILOT_HOME: home },
        encoding: "utf8",
    });
}

async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), "wayfinder-install-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    return { home, target: join(home, "extensions", "wayfinder-map") };
}

test("installs a fresh checkout into a user home with spaces", async (t) => {
    const { home } = await fixture(t);
    const copilotHome = join(home, "Copilot home");
    const result = install(copilotHome);
    assert.equal(result.status, 0, result.stderr);
    for (const name of sourceFiles) {
        const installed = join(copilotHome, "extensions", "wayfinder-map", name);
        assert.equal((await lstat(installed)).isSymbolicLink(), true, name);
        assert.equal(await realpath(installed), await realpath(join(sourceDir, name)));
    }
});

test("installs a checkout and preserves existing user artifacts", async (t) => {
    const { home, target } = await fixture(t);
    await mkdir(join(target, "artifacts"), { recursive: true });
    await writeFile(join(target, "artifacts", "links.json"), "private state");
    for (const name of sourceFiles) {
        await copyFile(join(sourceDir, name), join(target, name));
    }

    const first = install(home);
    assert.equal(first.status, 0, first.stderr);
    for (const name of sourceFiles) {
        const installed = join(target, name);
        assert.equal((await lstat(installed)).isSymbolicLink(), true, name);
        assert.equal(await realpath(installed), await realpath(join(sourceDir, name)));
    }
    assert.equal(await readFile(join(target, "artifacts", "links.json"), "utf8"), "private state");
    const second = install(home);
    assert.equal(second.status, 0, second.stderr);
});

test("refuses a conflicting file before replacing any existing source", async (t) => {
    const { home, target } = await fixture(t);
    await mkdir(target, { recursive: true });
    for (const name of sourceFiles) {
        await copyFile(join(sourceDir, name), join(target, name));
    }
    await writeFile(join(target, "ui.html"), "local changes");

    const result = install(home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace/);
    assert.equal(await readFile(join(target, "ui.html"), "utf8"), "local changes");
    assert.equal((await lstat(join(target, "extension.mjs"))).isSymbolicLink(), false);
});

test("refuses a differently linked file and a linked extension directory", async (t) => {
    const { home, target } = await fixture(t);
    await mkdir(target, { recursive: true });
    await symlink(join(sourceDir, "ui.html"), join(target, "extension.mjs"));

    let result = install(home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace an existing link/);
    assert.equal(await realpath(join(target, "extension.mjs")), await realpath(join(sourceDir, "ui.html")));

    const otherHome = join(home, "other");
    await mkdir(join(otherHome, "extensions"), { recursive: true });
    await symlink(sourceDir, join(otherHome, "extensions", "wayfinder-map"));
    result = install(otherHome);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to modify the symlinked extension directory/);
});

test("refuses to install the global extension into the checkout", () => {
    const result = install(join(root, ".github"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be outside this checkout/);
});

test("the project extension is a source-only gist package", async () => {
    const manifest = JSON.parse(await readFile(join(sourceDir, "copilot-extension.json"), "utf8"));
    assert.deepEqual(manifest, { name: "wayfinder-map", version: 1 });
    for (const name of [
        "extension.mjs", "adapters.mjs", "maps.mjs", "model.mjs", "prompts.mjs",
        "server.mjs", "sessions.mjs", "store.mjs", "ui.html", "README.md",
    ]) {
        assert.ok(sourceFiles.includes(name), `Missing ${name}`);
    }
    await assert.rejects(lstat(join(sourceDir, "artifacts")), { code: "ENOENT" });
});
