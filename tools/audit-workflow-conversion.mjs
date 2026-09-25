/**
 * tools/audit-workflow-conversion.mjs — measure what a UI→API conversion actually sends.
 *
 * The refactor deliberately edits one upstream file (see tools/upstream-deviations.txt), so
 * "did an upstream sync break this again?" has to be answerable by measurement rather than by
 * reading the diff. This script converts every saved workflow twice — once with the pristine
 * upstream copy from git, once with the working tree — and counts the widget inputs whose value
 * contradicts the node's own /object_info declaration. Those are the inputs ComfyUI rejects at
 * POST /prompt (a string in a FLOAT) or silently rewrites (a COMBO value not in the option list).
 *
 * Read-only: it never POSTs anything. It needs the compute box for /object_info and the workflow
 * list, so it degrades to a clear failure when the link is down (see tools/live-verify.sh).
 *
 *   node tools/audit-workflow-conversion.mjs [--bridge http://127.0.0.1:8002]
 *   node tools/audit-workflow-conversion.mjs --object-info /tmp/oi.json --workflows ./workflows
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const bridge = arg("bridge", process.env.COMFYUI_URL || "http://127.0.0.1:8002");
const oiPath = arg("object-info", "");
const localDir = arg("workflows", "");

const REPO = new URL("../", import.meta.url).pathname;

function loadObjectInfo() {
    if (oiPath && existsSync(oiPath)) return JSON.parse(readFileSync(oiPath, "utf8"));
    const out = execFileSync("curl", ["-s", "--max-time", "180", `${bridge}/api/object_info`], {
        maxBuffer: 512 * 1024 * 1024, encoding: "utf8",
    });
    if (!out || out.trimStart().startsWith("<")) {
        throw new Error(`/api/object_info did not answer through ${bridge} — is the box up? (tools/live-verify.sh)`);
    }
    return JSON.parse(out);
}

function loadWorkflows() {
    if (localDir) {
        return readdirSync(localDir).filter((f) => f.endsWith(".json")).map((f) => ({
            filename: f, raw: JSON.parse(readFileSync(join(localDir, f), "utf8")),
        }));
    }
    const list = JSON.parse(execFileSync("curl", ["-s", "--max-time", "60", `${bridge}/api/wfm/workflows`], { encoding: "utf8" }));
    if (!Array.isArray(list)) throw new Error(`${bridge}/api/wfm/workflows did not return a list`);
    const out = [];
    for (const entry of list) {
        const filename = entry.filename ?? entry;
        const url = `${bridge}/api/wfm/workflows/raw?filename=${encodeURIComponent(filename)}`;
        try {
            out.push({ filename, raw: JSON.parse(execFileSync("curl", ["-s", "--max-time", "60", url], { encoding: "utf8" })) });
        } catch (e) {
            console.log(`  skip ${filename}: unreadable`);
        }
    }
    return out;
}

/** The pristine upstream copy of the file the fork edits, written into a temp dir for import. */
function upstreamCopy(devPath, ref) {
    const dir = mkdtempSync(join(tmpdir(), "wfm-upstream-"));
    const file = join(dir, devPath.replace(/[\\/]/g, "_"));
    writeFileSync(file, execFileSync("git", ["show", `${ref}:${devPath}`], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }));
    return { file, dir };
}

/** A value that cannot be right for the slot it sits in. */
function violations(graph, objectInfo) {
    const out = [];
    for (const [id, node] of Object.entries(graph || {})) {
        const def = objectInfo[node.class_type];
        if (!def?.input) continue;
        for (const [key, value] of Object.entries(node.inputs || {})) {
            if (Array.isArray(value) || value === null || value === undefined) continue;
            const spec = def.input.required?.[key] ?? def.input.optional?.[key];
            if (!Array.isArray(spec)) continue;
            const kind = spec[0];
            if (typeof kind === "string" && ["INT", "FLOAT"].includes(String(kind).toUpperCase())) {
                if (typeof value === "string" && value !== "" && Number.isNaN(Number(value))) {
                    out.push(`${id}.${key}=${JSON.stringify(value)} wants ${kind}`);
                }
            } else if (Array.isArray(kind)) {
                // An empty option list means the custom node has nothing installed to choose from;
                // that is an installation state, not a conversion defect.
                if (kind.length && typeof value === "string" && !kind.includes(value)) {
                    out.push(`${id}.${key}=${JSON.stringify(value)} not a listed choice`);
                }
            }
        }
    }
    return out;
}

const objectInfo = loadObjectInfo();
console.log(`object_info: ${Object.keys(objectInfo).length} classes`);

const devPath = "static/js/comfyui-workflow.js";
const ref = arg("upstream-ref", "upstream/main");
let upstream;
try {
    upstream = upstreamCopy(devPath, ref);
} catch (e) {
    console.error(`cannot read ${ref}:${devPath} (${String(e.message).slice(0, 60)}) — pass --upstream-ref <ref>`);
    process.exit(2);
}
let beforeConvert;
let afterConvert;
try {
    ({ comfyWorkflow: beforeConvert } = await import(upstream.file));
    ({ comfyWorkflow: afterConvert } = await import(`${REPO}static/js/core/workflow.js`));
} finally {
    rmSync(upstream.dir, { recursive: true, force: true });
}

const fetchStub = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => objectInfo });
const workflows = loadWorkflows();

let converted = 0;
let before = 0;
let after = 0;
const diffs = [];
for (const { filename, raw } of workflows) {
    if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.links)) continue;
    try {
        const vb = violations(await beforeConvert.convertUiToApi(JSON.parse(JSON.stringify(raw))), objectInfo);
        const va = violations(await afterConvert.convertUiToApi(JSON.parse(JSON.stringify(raw))), objectInfo);
        converted++;
        before += vb.length;
        after += va.length;
        const repaired = vb.filter((x) => !va.includes(x));
        const introduced = va.filter((x) => !vb.includes(x));
        if (repaired.length || introduced.length) diffs.push({ filename, repaired, introduced });
    } catch (e) {
        console.log(`  convert threw for ${filename}: ${String(e.message).slice(0, 80)}`);
    }
}
globalThis.fetch = fetchStub;

console.log(JSON.stringify({ upstreamRef: ref, uiWorkflows: converted, violationsUpstream: before, violationsFork: after }, null, 1));
for (const d of diffs) console.log("  ", JSON.stringify(d));
process.exit(diffs.some((d) => d.introduced.length) ? 1 : 0);
