#!/usr/bin/env node
/**
 * tools/core-tests/import-check.mjs
 *
 * Static + runtime integration check for the core layer:
 *  1. every module under static/js/core/ imports cleanly in Node,
 *  2. every `api.<name>` referenced by a core module actually exists in core/api.js,
 *  3. core/index.js re-exports resolve,
 *  4. no core module touches the DOM (the §2.2 rule, enforced in JS not only by grep).
 *
 * Run: node tools/core-tests/import-check.mjs
 * Exit code = number of problems (0 = clean).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, "../../static/js/core");

// core/settings.js reaches for localStorage at call time, not import time, so a
// minimal shim is enough to import the whole layer in Node.
if (!globalThis.localStorage) {
    const mem = new Map();
    globalThis.localStorage = {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
        clear: () => mem.clear(),
        get length() { return mem.size; },
        key: (i) => [...mem.keys()][i] ?? null,
    };
}

let problems = 0;
const bad = (msg) => { console.error(`[FAIL] ${msg}`); problems++; };
const ok = (msg) => console.log(`[ ok ] ${msg}`);

const files = readdirSync(CORE).filter((f) => f.endsWith(".js")).sort();

// --- 1 + 4 -------------------------------------------------------------------
const DOM_TOKENS = [
    /\bdocument\s*\./,
    /\bwindow\s*\./,
    /\bgetElementById\b/,
    /\bquerySelector(All)?\b/,
    /\binnerHTML\b/,
];

for (const f of files) {
    const src = readFileSync(join(CORE, f), "utf8");
    const hit = DOM_TOKENS.find((re) => re.test(src));
    if (hit) bad(`${f} touches the DOM (${hit})`);
}

const modules = new Map();
for (const f of files) {
    try {
        modules.set(f, await import(join(CORE, f)));
    } catch (err) {
        bad(`${f} failed to import: ${err.message}`);
    }
}
if (modules.size === files.length) ok(`all ${files.length} core modules import cleanly and are DOM-free`);

// --- 2 -----------------------------------------------------------------------
const apiMod = modules.get("api.js");
const apiNames = apiMod ? new Set(Object.keys(apiMod)) : new Set();

const CALL_RE = /\bapi\.([A-Za-z_$][\w$]*)/g;
const MISSING_NS = [];
for (const [f, mod] of modules) {
    if (f === "api.js") continue;
    const src = readFileSync(join(CORE, f), "utf8");
    const seen = new Set();
    for (const m of src.matchAll(CALL_RE)) {
        if (m[1] === "js") continue; // `./api.js` in an import specifier, not a member access
        seen.add(m[1]);
    }
    for (const name of seen) {
        if (!apiNames.has(name)) MISSING_NS.push(`${f} calls api.${name} — not exported by api.js`);
    }
}
if (MISSING_NS.length === 0) ok("every api.<name> used by a core module exists in api.js");
else MISSING_NS.forEach(bad);

// Also catch `import { x } from "./api.js"` style usage.
for (const [f, mod] of modules) {
    if (f === "api.js") continue;
    const src = readFileSync(join(CORE, f), "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/api\.js"/g)) {
        for (const raw of m[1].split(",")) {
            const name = raw.trim().split(/\s+as\s+/).pop().trim();
            if (name && !apiNames.has(name)) bad(`${f} imports { ${name} } from api.js — not exported`);
            // a named import that exists but the module also needs `api.` -> nothing to check
        }
    }
    void mod;
}

// --- 3 -----------------------------------------------------------------------
try {
    const index = await import(join(CORE, "index.js"));
    const required = [
        "comfyUI", "comfyWorkflow", "t", "initI18n", "getSettings", "escapeHtml",
        "readPref", "writePref", "highlightJSON", "runGeneration",
        "TYPE_LABELS", "MODEL_TYPES", "FETCH_MAP", "GENUI_TYPE_MAP", "SORT_COLUMNS",
        "api", "batch", "pipeline", "style", "wildcard", "lora", "models", "image",
        "client", "workflow", "i18n", "settings", "json", "modelConstants",
    ];
    const missing = required.filter((k) => !(k in index));
    if (missing.length === 0) ok(`core/index.js exposes all ${required.length} contracted names`);
    else bad(`core/index.js is missing: ${missing.join(", ")}`);
} catch (err) {
    bad(`core/index.js failed to import: ${err.message}`);
}

// --- 5: newui must not import anything but core/index.js and its own files ---
const NEWUI = resolve(here, "../../static/js/newui");
const ALLOWED_UPSTREAM = /from\s+"\.\.\/core\/index\.js"|from\s+"\.\.\/\.\.\/core\/index\.js"/;
let newuiFiles = [];
try {
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".js")) newuiFiles.push(p);
        }
    };
    walk(NEWUI);
} catch { /* newui not present yet */ }

let violations = 0;
for (const p of newuiFiles) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1];
        if (!spec.startsWith(".")) { violations++; bad(`${p} imports a bare specifier "${spec}"`); continue; }
        if (spec.includes("/core/") && !ALLOWED_UPSTREAM.test(`from "${spec}"`)) {
            violations++; bad(`${p} bypasses core/index.js with "${spec}"`);
        }
    }
}
if (newuiFiles.length && violations === 0) ok(`all ${newuiFiles.length} newui modules import only core/index.js + their own tree`);

// --- 6: the upstream-UI import ban ------------------------------------------
const BANNED = /from\s+"\.\.?\/(generate-tab|gallery-tab|workflow-tab|settings-tab|comfyui-editor|prompt-|models-tab|models\/|app)/;
let banned = 0;
for (const p of newuiFiles) {
    if (BANNED.test(readFileSync(p, "utf8"))) { banned++; bad(`${p} imports an upstream UI module`); }
}
if (newuiFiles.length && banned === 0) ok("no newui module imports an upstream UI module");

void createRequire;
console.log(`\n${problems} problem(s)`);
process.exit(problems);
