// tools/expressive-palette-check.mjs
//
// WCAG 1.4.3 check for the colour pairs the Expressive rewrite introduced,
// computed from the token files instead of from a rendered page.
//
// Why a second tool when tools/contrast-audit.mjs exists: that one walks the DOM
// and composites whatever is behind each text node, which needs a painted page and
// (for the tone pairs added here) data on screen. These pairs are known at author
// time — they are two oklch() literals in m3-tokens.css — so measuring them is
// arithmetic, and arithmetic does not wait for a ComfyUI box to be reachable.
//
// The conversion is validated against a positive control before anything is
// asserted: the repository documents on-primary-container over primary-container
// as 7.24:1 in the dark scheme and 13.27:1 in the light one (theme-m3.css header).
// If the implementation cannot reproduce those two numbers, it reports that and
// exits non-zero rather than printing its own invention as a result.
//
// Usage: node tools/expressive-palette-check.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tokens = readFileSync(path.join(root, "static/css/newui/m3-tokens.css"), "utf8");

/** Every --md-ref-palette-<name>-<tone>: oklch(L C H) in the file. */
const PALETTE = new Map();
for (const m of tokens.matchAll(/--md-ref-palette-([a-z-]+)-(\d+):\s*oklch\(([^)]+)\)/g)) {
    // the lightness is written as a percentage ("91.59%"), so Number() would be NaN
    const [l, c, h] = m[3].trim().split(/[\s,]+/).map((v) => parseFloat(v));
    if ([l, c, h].some((n) => !Number.isFinite(n))) throw new Error(`unparsed oklch(): ${m[3]}`);
    PALETTE.set(`${m[1]}-${m[2]}`, { l: l / 100, c, h });
}
if (PALETTE.size < 60) throw new Error(`only ${PALETTE.size} palette tones parsed — the file shape changed`);

function oklchToLinSrgb({ l, c, h }) {
    const hr = (h * Math.PI) / 180;
    const a = c * Math.cos(hr);
    const b = c * Math.sin(hr);
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
    return [
        0.0000000 + 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
        0.0000000 - 1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
        0.0000000 - 0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S,
    ];
}

function relativeLuminance(color) {
    // WCAG weights the *linear* components; sRGB encoding is only for display, so
    // gamma-encoding before weighting is the classic way to get this wrong.
    const [r, g, b] = oklchToLinSrgb(color).map((v) => Math.max(0, Math.min(1, v)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(onName, backName) {
    const on = PALETTE.get(onName), back = PALETTE.get(backName);
    if (!on || !back) throw new Error(`missing palette entry: ${onName} / ${backName}`);
    const a = relativeLuminance(on), b = relativeLuminance(back);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

// positive control — the two numbers the repository already certifies
const controls = [
    ["primary-90 on primary-30 (dark)", ratio("primary-90", "primary-30"), 7.24, 0.15],
    ["primary-10 on primary-90 (light)", ratio("primary-10", "primary-90"), 13.27, 0.6],
];
let failed = 0;
for (const [label, got, want, tolerance] of controls) {
    const ok = Math.abs(got - want) <= tolerance;
    console.log(`${ok ? "[ ok ]" : "[FAIL]"} control ${label}: measured ${got.toFixed(2)}:1, documented ${want}:1`);
    if (!ok) failed++;
}
if (failed) {
    console.error("The conversion does not reproduce the documented pairs, so its other numbers mean nothing.");
    process.exit(1);
}

// the new pairs: each expressive tone container with its own on-container colour,
// in both schemes, at the same tone numbers the audited primary pair uses.
const AA_TEXT = 4.5;
const schemes = [
    { name: "dark (container tone 30 / on tone 90)", back: 30, on: 90 },
    { name: "light (container tone 90 / on tone 10)", back: 90, on: 10 },
];
for (const family of ["primary", "spring", "peach", "sky"]) {
    for (const s of schemes) {
        const got = ratio(`${family}-${s.on}`, `${family}-${s.back}`);
        const verdict = got >= AA_TEXT ? "AA" : "BELOW AA";
        if (got < AA_TEXT) failed++;
        console.log(`[  ${got >= AA_TEXT ? "AA" : "!!" } ] ${family} ${s.name}: ${got.toFixed(2)}:1 — ${verdict}`);
    }
}

assert.ok(PALETTE.has("spring-30") && PALETTE.has("peach-90") && PALETTE.has("sky-10"), "tone palettes incomplete");
console.log(failed ? `${failed} pair(s) below AA` : "all expressive tone pairs pass AA in both schemes");
process.exit(failed ? 1 : 0);
