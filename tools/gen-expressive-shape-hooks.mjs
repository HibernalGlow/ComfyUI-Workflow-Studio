// tools/gen-expressive-shape-hooks.mjs
//
// Generates static/css/newui/expressive-hooks.css — the Expressive shape layer of
// the @material/web components this app renders.
//
// Why a generator instead of hand-written CSS:
//   * The hook names belong to the installed package, not to this repo. They are
//     read out of the package's own compiled JS. A mistyped name is a declaration
//     the browser silently ignores, so "it looks themed" is not evidence.
//   * A shape hook only ANIMATES if it is registered with @property first. An
//     unregistered custom property changes value in one step, which would turn
//     the expressive morph into a visible glitch.
//   * Registration has a second trap: @property's `initial-value` must be
//     guaranteed-valid, and var() is not — a registration that references a token
//     is dropped whole, silently disabling the morph. So every initial-value here
//     is a literal length, and the same literal is what the token it mirrors
//     resolves to (the table below is checked against m3-tokens.css).
//   * The file only has to cover what the app actually mounts, and that is
//     knowable from the define<...>("md-...") calls in frontend/src/md.ts.
//
// Usage:  node tools/gen-expressive-shape-hooks.mjs
//         node tools/gen-expressive-shape-hooks.mjs --check   // exit 1 on drift
//         node tools/gen-expressive-shape-hooks.mjs --print   // stdout only

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "static/css/newui/expressive-hooks.css");
const TOKENS = path.join(root, "static/css/newui/m3-tokens.css");
const CHECK = process.argv.includes("--check");
const PRINT = process.argv.includes("--print");

/** The corner steps, as written in m3-tokens.css. Asserted against that file. */
const STEP_PX = {
    none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
    "lg-increased": "20px", xl: "28px", "xl-increased": "32px", xxl: "48px", full: "9999px",
};
for (const [name, px] of Object.entries(STEP_PX)) {
    const token = `--md-sys-shape-corner-${name}: ${px};`;
    if (!readFileSync(TOKENS, "utf8").includes(token)) {
        throw new Error(
            `m3-tokens.css no longer declares "${token}". The @property initial-values here are ` +
            `literals, so they must be updated together with the token or the registration is wrong.`,
        );
    }
}
const step = (name) => ({ token: `var(--md-sys-shape-corner-${name})`, px: STEP_PX[name] });

/** md.ts mounts the elements; only their hooks are emitted. */
const mdts = readFileSync(path.join(root, "frontend/src/md.ts"), "utf8");
const TAGS = [...mdts.matchAll(/define<[^>]*>\(\s*"(md-[a-z0-9-]+)"/g)].map((m) => m[1]);
const UNIQUE_TAGS = [...new Set(TAGS)].sort();

/**
 * tag -> {dirs, prefixes, role}
 * `prefixes` is a list because some components read two stems (an
 * outlined-text-field resolves both --md-outlined-field-* and
 * --md-outlined-text-field-*), and md-fab ships four size variants in one dir.
 */
const KNOWN = {
    "md-filled-button": { dirs: ["button"], prefixes: ["filled-button"], role: "control-pill" },
    "md-filled-tonal-button": { dirs: ["button"], prefixes: ["filled-tonal-button"], role: "control-pill" },
    "md-outlined-button": { dirs: ["button"], prefixes: ["outlined-button"], role: "control-pill" },
    "md-text-button": { dirs: ["button"], prefixes: ["text-button"], role: "control-pill" },
    "md-elevated-button": { dirs: ["button"], prefixes: ["elevated-button"], role: "control-pill" },
    "md-icon-button": { dirs: ["iconbutton"], prefixes: ["icon-button"], role: "icon-circle" },
    "md-filled-icon-button": { dirs: ["iconbutton"], prefixes: ["filled-icon-button"], role: "icon-circle" },
    "md-filled-tonal-icon-button": { dirs: ["iconbutton"], prefixes: ["filled-tonal-icon-button"], role: "icon-circle" },
    "md-outlined-icon-button": { dirs: ["iconbutton"], prefixes: ["outlined-icon-button"], role: "icon-circle" },
    "md-fab": { dirs: ["fab"], prefixes: ["fab", "fab-small", "fab-large", "fab-branded"], role: "squircle" },
    "md-outlined-text-field": { dirs: ["textfield"], prefixes: ["outlined-text-field", "outlined-field"], role: "field" },
    "md-filled-text-field": { dirs: ["textfield"], prefixes: ["filled-text-field", "filled-field"], role: "field" },
    "md-outlined-select": { dirs: ["select"], prefixes: ["outlined-select-text-field", "outlined-field"], role: "field" },
    "md-filled-select": { dirs: ["select"], prefixes: ["filled-select-text-field", "filled-field"], role: "field" },
    "md-select-option": { dirs: ["select"], prefixes: ["select-option"], role: "menu-item" },
    "md-slider": { dirs: ["slider"], prefixes: ["slider"], role: "slider" },
    "md-switch": { dirs: ["switch"], prefixes: ["switch"], role: "switch" },
    "md-checkbox": { dirs: ["checkbox"], prefixes: ["checkbox"], role: "check" },
    "md-radio": { dirs: ["radio"], prefixes: ["radio"], role: "radio" },
    "md-assist-chip": { dirs: ["chips"], prefixes: ["assist-chip"], role: "control-pill" },
    "md-filter-chip": { dirs: ["chips"], prefixes: ["filter-chip"], role: "control-pill" },
    "md-input-chip": { dirs: ["chips"], prefixes: ["input-chip"], role: "control-pill" },
    "md-suggestion-chip": { dirs: ["chips"], prefixes: ["suggestion-chip"], role: "control-pill" },
    "md-chip-set": { dirs: ["chips"], prefixes: [], role: null },
    "md-dialog": { dirs: ["dialog"], prefixes: ["dialog"], role: "sheet" },
    "md-menu": { dirs: ["menu"], prefixes: ["menu"], role: "sheet" },
    "md-menu-item": { dirs: ["menu"], prefixes: ["menu-item"], role: "menu-item" },
    "md-list": { dirs: ["list"], prefixes: ["list"], role: null },
    "md-list-item": { dirs: ["list"], prefixes: ["list-item"], role: "list-item" },
    "md-tabs": { dirs: ["tabs"], prefixes: ["tabs"], role: null },
    "md-primary-tab": { dirs: ["tabs"], prefixes: ["primary-tab"], role: "tab" },
    "md-linear-progress": { dirs: ["progress"], prefixes: ["linear-progress"], role: "bar" },
    "md-circular-progress": { dirs: ["progress"], prefixes: ["circular-progress"], role: null },
    "md-divider": { dirs: ["divider"], prefixes: ["divider"], role: null },
    "md-icon": { dirs: ["icon"], prefixes: ["icon"], role: null },
    "md-filled-card": { dirs: ["labs/card"], prefixes: ["filled-card"], role: "card" },
    "md-outlined-card": { dirs: ["labs/card"], prefixes: ["outlined-card"], role: "card" },
    "md-elevated-card": { dirs: ["labs/card"], prefixes: ["elevated-card"], role: "card" },
    "md-item": { dirs: ["labs/item"], prefixes: ["item"], role: null },
};

/**
 * Shape roles — rest / hover / press, the three states an Expressive control
 * springs between (pill at rest, a big uniform radius on hover, a collapsed small
 * corner at the moment of press). Values name --md-sys-shape-corner-* steps in
 * m3-tokens.css; press=none means "static, no morph rule is emitted".
 */
const ROLES = {
    "control-pill": { rest: step("full"), hover: step("lg-increased"), press: step("md") },
    "icon-circle": { rest: step("full"), hover: step("xl"), press: step("lg") },
    squircle: { rest: step("xl"), hover: step("xl-increased"), press: step("lg") },
    field: { rest: step("lg"), hover: step("lg-increased"), press: step("xl") },
    "menu-item": { rest: step("lg-increased"), hover: step("full"), press: step("md") },
    "list-item": { rest: step("lg"), hover: step("full"), press: step("md") },
    tab: { rest: step("full"), hover: step("lg-increased"), press: step("md") },
    card: { rest: step("xl-increased"), hover: step("xxl"), press: step("lg") },
    sheet: { rest: step("xl-increased"), hover: step("xl-increased"), press: step("xl-increased") },
    slider: { rest: step("full"), hover: null, press: null },
    switch: { rest: step("full"), hover: null, press: null },
    check: { rest: step("sm"), hover: step("lg-increased"), press: step("xs") },
    radio: { rest: step("full"), hover: null, press: null },
    bar: { rest: step("full"), hover: null, press: null },
};

const CORNERS = ["start-start", "start-end", "end-end", "end-start"];
const cornerHook = (prefix, corner) => `--md-${prefix}-container-shape-${corner}`;

/** Every --md-*shape* hook name declared anywhere under the given dirs. */
function hooksFor(dirs) {
    const names = new Set();
    for (const dir of dirs) {
        const abs = path.join(root, "node_modules/@material/web", dir);
        if (!existsSync(abs)) throw new Error(`@material/web/${dir} is missing — reinstall dependencies`);
        for (const rel of readdirSync(abs, { recursive: true })) {
            if (!rel.endsWith(".js") || rel.endsWith(".map")) continue;
            for (const m of readFileSync(path.join(abs, rel), "utf8").matchAll(/--md-[a-z0-9-]*shape[a-z0-9-]*/g)) {
                names.add(m[0]);
            }
        }
    }
    return [...names].filter((n) => !n.startsWith("--md-sys-")).sort();
}

const props = [];
const values = [];
const morphs = [];
const notes = [];

function register(name, initialPx) {
    props.push(
        `@property ${name} {\n  syntax: "<length-percentage>";\n  inherits: true;\n  initial-value: ${initialPx};\n}`,
    );
}

for (const tag of UNIQUE_TAGS) {
    const known = KNOWN[tag];
    if (!known) {
        notes.push(` *   ! ${tag} is mounted by md.ts but has no entry here, so its shape stays at the`);
        notes.push(` *       library default. Add it to KNOWN in this generator.`);
        continue;
    }
    if (!known.role) continue;
    const role = ROLES[known.role];
    const pool = hooksFor(known.dirs);
    const forPrefix = (prefix) => pool.filter((h) => h.startsWith(`--md-${prefix}-`));
    /* One rule per element: `transition` is a single property, so two rules on the
       same selector would replace each other and only the last stem's hooks would
       animate. Everything a tag morphs is collected first. */
    const animated = new Set();
    const statics = new Set();
    let cornerless = [];

    for (const prefix of known.prefixes) {
        const hooks = forPrefix(prefix);
        if (!hooks.length) continue;
        const corners = CORNERS.map((c) => cornerHook(prefix, c)).filter((h) => hooks.includes(h));
        const singles = hooks.filter((h) => !corners.includes(h));
        const followers = singles.filter((h) =>
            h.includes("state-layer-shape") || h.includes("focus-ring-shape") || h.includes("active-indicator-shape"));
        const rest = singles.filter((h) => !followers.includes(h));
        for (const h of rest) statics.add(h);
        if (corners.length === 4) {
            /* The state layer, focus ring and tab indicator are separate properties
               on the same control: registered and animated with the container, or
               they lag behind it and the hover overlay keeps the old shape. */
            for (const h of [...corners, ...followers]) animated.add(h);
        } else {
            cornerless.push(prefix);
            if (role.hover && role.press) for (const h of followers) animated.add(h);
        }
    }

    if (role.hover && role.press) {
        /* A component that only exposes one shape property can still spring as a
           whole — it just cannot go asymmetric, because one value drives all four
           corners. That is the case the notes below record. */
        const wholeSurface = [...statics].filter((h) =>
            h.endsWith("container-shape") || h.endsWith("track-shape") || h.endsWith("handle-shape") ||
            h.endsWith("avatar-shape") || h.endsWith("active-track-shape") || h.endsWith("inactive-track-shape"));
        const morphTargets = animated.size ? [...animated] : wholeSurface;
        if (morphTargets.length) {
            if (!animated.size) {
                /* the whole-surface hooks animate, so they leave the static list */
                for (const h of morphTargets) statics.delete(h);
            }
            for (const h of morphTargets) register(h, role.rest.px);
            morphs.push(
                `${tag} {\n  transition: ${morphTargets.map((h) => `${h} var(--md-e-spatial-fast)`).join(",\n              ")};\n}\n` +
                `${tag}:hover {\n${morphTargets.map((h) => `  ${h}: ${role.hover.token};`).join("\n")}\n}\n` +
                `${tag}:active {\n${morphTargets.map((h) => `  ${h}: ${role.press.token};`).join("\n")}\n}`,
            );
        }
    } else {
        for (const h of animated) statics.add(h);
        animated.clear();
    }
    for (const h of statics) values.push(`  ${h}: ${role.rest.token};`);
    if (cornerless.length && role.hover && role.press) {
        notes.push(` *   - ${tag}: no per-corner hooks on ${cornerless.join(", ")}, so it morphs as a whole`);
        notes.push(` *       instead of asymmetrically (one --md-*-shape value drives all four corners).`);
    }
}

const css = `/* GENERATED by tools/gen-expressive-shape-hooks.mjs — do not edit by hand.
   Regenerate:  node tools/gen-expressive-shape-hooks.mjs
   Drift check: node tools/gen-expressive-shape-hooks.mjs --check

   The Expressive shape layer for the @material/web components this app mounts.

   @material/web 2.5.0's classic components bake their geometry at build time and
   expose it through --md-<component>-<part>-shape custom properties, so theming
   them means naming every hook. The names were read out of the installed
   package's compiled JS and the element list out of frontend/src/md.ts, which
   keeps this file exactly as wide as the app.

   Registration notes, both of them silent failures if wrong:
     * a shape hook only interpolates once it is registered with @property;
     * @property initial-value must be guaranteed-valid, so it is a literal
       length rather than the token it mirrors (the generator asserts the literal
       still equals the step in m3-tokens.css before writing anything).

   Rest / hover / press per role for this run:
${notes.length ? notes.join("\n") : " *   (every mounted element resolved its hooks; nothing was skipped)"}
*/

${props.join("\n\n")}

:root {
${values.join("\n")}
}

/* --- the morph: shape springs on hover, collapses on press ----------------- */
${morphs.length ? morphs.join("\n\n") : "/* nothing morphable */"}
`;

if (PRINT) {
    process.stdout.write(css);
} else if (CHECK) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== css) {
        console.error("expressive-hooks.css is out of date — run: node tools/gen-expressive-shape-hooks.mjs");
        process.exit(1);
    }
    console.log("expressive-hooks.css matches the package.");
} else {
    writeFileSync(OUT, css);
    console.log(`wrote ${path.relative(root, OUT)} — ${UNIQUE_TAGS.length} element(s), ${props.length} @property, ${morphs.length} morph rule(s), ${notes.length} note line(s)`);
}
