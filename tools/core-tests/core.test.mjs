/**
 * tools/core-tests/core.test.mjs
 *
 * Unit tests for the DOM-free core layer. Run with:
 *     node --test tools/core-tests/
 *
 * These cover the parts of the P1 acceptance list that can be checked without a
 * browser or a live ComfyUI: wildcard expansion semantics (parity item 6),
 * style application (item 5), the metadata/group/badge/preference read-write
 * layer (models items 7, 15, and §2.2 rule 4), and the pure helpers.
 *
 * `globalThis.fetch` is replaced with a scripted fake so the tests exercise the
 * real request path in core/api.js (URL, method, body) instead of mocking it out.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Environment shims — core must run in Node without a browser.
// ---------------------------------------------------------------------------
const store = new Map();
const localStorageShim = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
};
globalThis.localStorage = localStorageShim;

/** Every request the code under test made, for asserting URL/method/body. */
let calls = [];
/** path (without query) -> responder. */
let routes = new Map();

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

function installFetch() {
    calls = [];
    routes = new Map();
    globalThis.fetch = async (url, init = {}) => {
        const raw = typeof url === "string" ? url : url.url;
        const u = new URL(raw, "http://localhost");
        calls.push({
            path: u.pathname,
            query: Object.fromEntries(u.searchParams),
            method: (init.method || "GET").toUpperCase(),
            body: init.body ? JSON.parse(init.body) : null,
        });
        const handler = routes.get(u.pathname);
        if (!handler) return new Response("not found", { status: 404 });
        return handler({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
    };
}

const lastCall = () => calls[calls.length - 1];
const callsTo = (path) => calls.filter((c) => c.path === path);

beforeEach(() => {
    store.clear();
    installFetch();
});

afterEach(() => {
    delete globalThis.fetch;
});

// Import AFTER the shims exist. Dynamic import caches, so this happens once.
const core = await import("../../static/js/core/index.js");
const { wildcard, style, models, settings, api, modelConstants, modelConstants: MC, widgets, lora, batch, comfyUI } = core;

// ===========================================================================
// model-constants — pure helpers (no I/O)
// ===========================================================================
test("model-constants: the 8 model types and their labels", () => {
    assert.deepEqual(MC.MODEL_TYPES, [
        "checkpoint", "lora", "vae", "controlnet",
        "unet", "textencoder", "hypernetwork", "embedding",
    ]);
    assert.equal(MC.MODEL_TYPES.length, 8);
    assert.equal(MC.typeLabel("lora"), "LoRA");
    assert.equal(MC.typeLabel("unknown-type"), "unknown-type");
});

test("model-constants: reserved groups and batch/stack applicability", () => {
    assert.deepEqual(MC.RESERVED_GROUPS, ["Batch", "Stack"]);
    assert.deepEqual(MC.BATCH_MODEL_TYPES, ["checkpoint", "lora"]);
    assert.deepEqual(MC.STACK_MODEL_TYPES, ["lora"]);
    assert.equal(MC.isBatchType("lora"), true);
    assert.equal(MC.isBatchType("vae"), false);
    assert.equal(MC.isStackType("lora"), true);
    assert.equal(MC.isStackType("checkpoint"), false);
});

test("model-constants: embedding has no GenerateUI slot", () => {
    assert.equal(MC.isSlotType("embedding"), false);
    assert.equal(MC.FETCH_MAP.embedding.inputKey, null);
    assert.equal(Object.keys(MC.GENUI_TYPE_MAP).length, 7);
    for (const type of MC.MODEL_TYPES) {
        if (type === "embedding") continue;
        assert.equal(MC.isSlotType(type), true, `${type} should be a slot type`);
    }
});

test("model-constants: path helpers split subdir / base / extension", () => {
    assert.equal(MC.subdirOf("a/b/c.safetensors"), "a/b");
    assert.equal(MC.subdirOf("c.safetensors"), "");
    assert.equal(MC.baseNameOf("a/b/c.safetensors"), "c.safetensors");
    assert.equal(MC.extOf("a/b/C.SafeTensors"), "safetensors");
    assert.equal(MC.extOf("noext"), "");
});

// ===========================================================================
// wildcard — parity item 6 (`__name__` expansion)
// ===========================================================================
test("wildcard: expands a token with a pinned RNG", async () => {
    routes.set("/api/wfm/wildcards/content", () =>
        json({ content: "red\n# a comment\ngreen\n\nblue\n" }));
    const out = await wildcard.expandWildcardText("a __colour__ b", { random: () => 0 });
    assert.equal(out, "a red b");
    assert.equal(callsTo("/api/wfm/wildcards/content")[0].query.filename, "colour.txt");
});

test("wildcard: comments and blank lines are dropped, RNG picks a later line", async () => {
    routes.set("/api/wfm/wildcards/content", () => json({ content: "one\n# skip\ntwo\nthree\n" }));
    const out = await wildcard.expandWildcardText("__x__", { random: () => 0.99 });
    assert.equal(out, "three");
});

test("wildcard: an unknown name is left in the text verbatim", async () => {
    // no route registered -> api throws -> cache stores a negative hit
    const out = await wildcard.expandWildcardText("keep __missing__ here", { random: () => 0 });
    assert.equal(out, "keep __missing__ here");
});

test("wildcard: expansion recurses through nested tokens", async () => {
    routes.set("/api/wfm/wildcards/content", ({ url }) => {
        const name = url.searchParams.get("filename");
        if (name === "outer.txt") return json({ content: "__inner__" });
        if (name === "inner.txt") return json({ content: "deep" });
        return new Response("nope", { status: 404 });
    });
    const out = await wildcard.expandWildcardText("__outer__", { random: () => 0 });
    assert.equal(out, "deep");
});

test("wildcard: a workflow without tokens is returned as the same object", async () => {
    const wf = { "1": { class_type: "KSampler", inputs: { text: "plain" } } };
    assert.equal(wildcard.workflowUsesWildcards(wf), false);
    const out = await wildcard.expandWildcardsInWorkflow(wf);
    assert.equal(out, wf, "the upstream fast path must return the input unchanged");
});

test("wildcard: Impact nodes are skipped so the pack can expand server-side", async () => {
    routes.set("/api/wfm/wildcards/content", () => json({ content: "IGNORED" }));
    const wf = {
        "1": { class_type: "ImpactWildcardEncode", inputs: { wildcard_text: "__a__" } },
    };
    assert.equal(wildcard.workflowUsesWildcards(wf), false);
    const out = await wildcard.expandWildcardsInWorkflow(wf);
    assert.equal(out["1"].inputs.wildcard_text, "__a__");
});

test("wildcard: a workflow with tokens is deep-cloned and expanded", async () => {
    routes.set("/api/wfm/wildcards/content", () => json({ content: "X" }));
    const wf = {
        "1": { class_type: "CLIPTextEncode", inputs: { text: "__a__", other: 5 } },
        "2": { class_type: "KSampler", inputs: { seed: 1 } },
    };
    const out = await wildcard.expandWildcardsInWorkflow(wf, { random: () => 0 });
    assert.equal(out["1"].inputs.text, "X");
    assert.equal(out["1"].inputs.other, 5);
    assert.equal(out["2"].inputs.seed, 1);
    assert.equal(wf["1"].inputs.text, "__a__", "the input workflow must not be mutated");
});

// ===========================================================================
// style — parity item 5
// ===========================================================================
const CATALOG = [
    { name: "Vivid", prompt: "vivid, saturated", negative_prompt: "blurry" },
    { name: "Templated", prompt: "{prompt}, masterpiece", negative_prompt: "" },
];
const ANALYSIS = {
    prompt_nodes: [
        { id: "1", role: "positive", textKey: "text" },
        { id: "2", role: "negative", textKey: "text" },
    ],
};

test("style: a style prompt without {prompt} is appended to the positive node", () => {
    const wf = {
        "1": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "lowres" } },
    };
    const out = style.applyNamedStyle(wf, CATALOG[0], ANALYSIS);
    assert.equal(out["1"].inputs.text, "a cat, vivid, saturated");
    assert.equal(out["2"].inputs.text, "lowres, blurry");
    assert.equal(wf["1"].inputs.text, "a cat", "input workflow must not be mutated");
});

test("style: {prompt} is substituted rather than appended", () => {
    const wf = { "1": { inputs: { text: "a cat" } }, "2": { inputs: { text: "lowres" } } };
    const out = style.applyNamedStyle(wf, CATALOG[1], ANALYSIS);
    assert.equal(out["1"].inputs.text, "a cat, masterpiece");
});

test("style: an empty positive node takes the style prompt as-is", () => {
    const wf = { "1": { inputs: { text: "" } }, "2": { inputs: { text: "" } } };
    const out = style.applyNamedStyle(wf, CATALOG[0], ANALYSIS);
    assert.equal(out["1"].inputs.text, "vivid, saturated");
    assert.equal(out["2"].inputs.text, "blurry");
});

test("style: missing style or analysis returns the input untouched", () => {
    const wf = { "1": { inputs: { text: "a cat" } } };
    assert.equal(style.applyNamedStyle(wf, null, ANALYSIS), wf);
    assert.equal(style.applyNamedStyle(wf, CATALOG[0], null), wf);
});

test("style: applyStyleToWorkflow honours the enabled flag", () => {
    style.setCachedStyles(CATALOG);
    const wf = { "1": { inputs: { text: "a cat" } }, "2": { inputs: { text: "lowres" } } };
    const off = style.applyStyleToWorkflow(wf, { enabled: false, styleName: "Vivid", analysis: ANALYSIS });
    assert.equal(off, wf, "disabled means untouched");

    const on = style.applyStyleToWorkflow(wf, { enabled: true, styleName: "Vivid", analysis: ANALYSIS });
    assert.equal(on["1"].inputs.text, "a cat, vivid, saturated");
});

test("style: a batch override wins over both the checkbox and the selected name", () => {
    style.setCachedStyles(CATALOG);
    const wf = { "1": { inputs: { text: "a cat" } }, "2": { inputs: { text: "lowres" } } };
    const out = style.applyStyleToWorkflow(wf, {
        enabled: false,
        styleName: "Templated",
        style: CATALOG[0],
        analysis: ANALYSIS,
    });
    assert.equal(out["1"].inputs.text, "a cat, vivid, saturated");
});

test("style: an unknown style name produces no change", () => {
    style.setCachedStyles(CATALOG);
    const wf = { "1": { inputs: { text: "a cat" } } };
    const out = style.applyStyleToWorkflow(wf, { styleName: "Nope", analysis: ANALYSIS });
    assert.equal(out["1"].inputs.text, "a cat");
});

// ===========================================================================
// settings — preference namespace + the shared settings key
// ===========================================================================
test("settings: readPref/writePref round-trip through the nu_ namespace", () => {
    assert.equal(settings.writePref("models_view", "table"), true);
    assert.equal(store.get("nu_models_view"), '"table"');
    assert.equal(settings.readPref("models_view", "thumb"), "table");
    assert.equal(settings.readPref("never_set", "fallback"), "fallback");
});

test("settings: prefs never touch the old-UI keys", () => {
    store.set("wfm_models_view", '"table"');
    assert.equal(settings.readPref("models_view", "thumb"), "thumb",
        "a pre-existing old-UI key must not leak into the new UI");
});

test("settings: updateSettings merges into the shared wfm_settings object", () => {
    store.set("wfm_settings", JSON.stringify({ comfyuiUrl: "http://box:8188", other: 1 }));
    const merged = settings.updateSettings({ outputDir: "/out" });
    assert.equal(merged.comfyuiUrl, "http://box:8188", "existing keys survive");
    assert.equal(merged.outputDir, "/out");
    assert.deepEqual(JSON.parse(store.get("wfm_settings")), { comfyuiUrl: "http://box:8188", other: 1, outputDir: "/out" });
});

test("settings: corrupt settings JSON degrades to an empty object", () => {
    store.set("wfm_settings", "{not json");
    assert.deepEqual(settings.readSettingsRaw(), {});
    assert.deepEqual(settings.getSettings(), {});
});

// ===========================================================================
// models — §2.2 rule 4 (all backend access through api.js) + §4 items 7/15
// ===========================================================================
test("models: metadata is read from the metadata endpoint", async () => {
    routes.set("/api/wfm/models/metadata", () => json({
        "a.safetensors": { tags: ["style"], favorite: true, memo: "hi" },
    }));
    const md = await models.loadMetadata();
    assert.equal(lastCall().path, "/api/wfm/models/metadata");
    assert.equal(lastCall().method, "GET");
    assert.equal(md["a.safetensors"].favorite, true);
});

test("models: saving metadata posts modelName + the updates", async () => {
    routes.set("/api/wfm/models/metadata", () => json({ status: "ok", metadata: { tags: ["x"] } }));
    await models.saveMetadata("a.safetensors", { tags: ["x"] });
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, { modelName: "a.safetensors", tags: ["x"] });
});

test("models: entryOf normalises a legacy row", () => {
    const e = models.entryOf({ "a.safetensors": { favorite: true } }, "a.safetensors");
    assert.deepEqual(e.tags, []);
    assert.deepEqual(e.badges, []);
    assert.equal(e.memo, "");
    assert.equal(e.favorite, true);
    assert.deepEqual(models.entryOf({}, "absent").tags, []);
});

test("models: toggleFavorite flips without mutating the entry", () => {
    const md = { "a.safetensors": { tags: [], favorite: false, memo: "" } };
    assert.equal(models.toggleFavorite(md, "a.safetensors").favorite, true);
    assert.equal(md["a.safetensors"].favorite, false);
});

test("models: withTag / withBadge add and remove", () => {
    const entry = { tags: ["a"], badges: ["WIP"] };
    assert.deepEqual(models.withTag(entry, "b", true).sort(), ["a", "b"]);
    assert.deepEqual(models.withTag(entry, "a", false), []);
    assert.deepEqual(models.withBadge(entry, "★", true).sort(), ["WIP", "★"]);
    assert.deepEqual(models.withBadge(entry, "WIP", false), []);
});

test("models: groups are read per type and saved as a whole map", async () => {
    routes.set("/api/wfm/models/groups", () => json({ Batch: ["a.safetensors"] }));
    const groups = await models.loadGroups("checkpoint");
    assert.equal(lastCall().query.type, "checkpoint");
    assert.deepEqual(groups, { Batch: ["a.safetensors"] });

    await models.saveGroups("checkpoint", { Batch: ["a.safetensors"], Mine: [] });
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, {
        model_type: "checkpoint",
        groups: { Batch: ["a.safetensors"], Mine: [] },
    });
});

test("models: group membership helpers are pure", () => {
    const g = { Batch: ["a", "b"], Stack: ["c"] };
    assert.deepEqual(models.withMembers(g, "Batch", ["b", "d"], true).Batch.sort(), ["a", "b", "d"]);
    assert.deepEqual(models.withMembers(g, "Batch", ["a"], false).Batch, ["b"]);
    assert.deepEqual(Object.keys(models.withoutGroup(g, "Stack")), ["Batch"]);
    assert.deepEqual(models.renameGroup(g, "Batch", "Daily").Daily, ["a", "b"]);
    assert.equal(models.renameGroup(g, "Batch", "Daily").Batch, undefined);
    assert.deepEqual(models.groupsOf(g, "a"), ["Batch"]);
    assert.deepEqual(models.groupsOf(g, "zzz"), []);
    assert.deepEqual(g, { Batch: ["a", "b"], Stack: ["c"] }, "inputs must not be mutated");
});

test("models: aggregateTags unions sorted tags across the given models", () => {
    const md = {
        "a": { tags: ["portrait", "style"] },
        "b": { tags: ["style"] },
        "c": { tags: [] },
    };
    assert.deepEqual(models.aggregateTags(md, ["a", "b", "c"]), ["portrait", "style"]);
    assert.deepEqual(models.aggregateTags(md), ["portrait", "style"]);
});

test("models: badges aggregate from metadata and the palette", () => {
    const md = { "a": { badges: ["WIP"] } };
    assert.deepEqual(models.aggregateBadges(md, ["a"], { WIP: "#fff", "★": "#000" }).sort(), ["WIP", "★"]);
    assert.deepEqual(models.aggregateBadges({}, [], { "": "" }), [], "the empty label is not a badge");
});

test("models: the badge palette uses a nu_ pref, never the old-UI key", () => {
    store.set("wfm_models_badge_palette", JSON.stringify({ Old: "#123456" }));
    assert.deepEqual(models.getBadgePalette(), {}, "old-UI palette must not be read");
    models.saveBadgePalette({ WIP: "#0f0" });
    assert.equal(store.get("nu_models_badge_palette"), JSON.stringify({ WIP: "#0f0" }));
    assert.equal(store.get("wfm_models_badge_palette"), JSON.stringify({ Old: "#123456" }),
        "the old-UI key must not be written");
    assert.equal(models.badgeColor({ WIP: "#0f0" }, "WIP"), "#0f0");
    assert.equal(models.badgeColor({ WIP: "#0f0" }, "absent"), null,
        "no colour means the caller falls back to a design token, not to a literal");
});
test("models: disabled models load as a Set and default to enabled", async () => {
    routes.set("/api/wfm/models/disabled", () => json(["off.safetensors"]));
    const set = await models.loadDisabled("lora");
    assert.equal(lastCall().query.type, "lora");
    assert.equal(set.has("off.safetensors"), true);
    assert.equal(models.isEnabled(set, "on.safetensors"), true);
    assert.equal(models.isEnabled(set, "off.safetensors"), false);
});

test("models: enabling posts the toggle payload", async () => {
    routes.set("/api/wfm/models/toggle", () => json({ status: "ok", enabled: false }));
    await models.setEnabled("lora", "a.safetensors", false);
    assert.deepEqual(lastCall().body, {
        model_type: "lora", model_name: "a.safetensors", enabled: false,
    });
});

test("models: civitaiUrl builds a model URL, a version URL, or null", () => {
    assert.equal(models.civitaiUrl({ modelId: 7, id: 9 }), "https://civitai.com/models/7?modelVersionId=9");
    assert.equal(models.civitaiUrl({ id: 9 }), "https://civitai.com/model-versions/9");
    assert.equal(models.civitaiUrl({ modelId: 7 }), "https://civitai.com/models/7");
    assert.equal(models.civitaiUrl({}), null);
    assert.equal(models.civitaiUrl({ modelId: 7, id: 9 }, "civitai.example"), "https://civitai.example/models/7?modelVersionId=9");
});

test("models: the civitai host pref is namespaced", () => {
    store.set("wfm_civitai_host", "old.example");
    assert.equal(models.getCivitaiHost(), "civitai.com");
    models.setCivitaiHost("mirror.example");
    assert.equal(store.get("nu_civitai_host"), '"mirror.example"');
});

test("models: the Civitai cache is looked up by hash first, then name", () => {
    const cache = { abc: { id: 1 }, "a.safetensors": { id: 2 } };
    assert.deepEqual(models.civitaiFor(cache, { sha256: "abc", name: "a.safetensors" }), { id: 1 });
    assert.deepEqual(models.civitaiFor(cache, { name: "a.safetensors" }), { id: 2 });
    assert.equal(models.civitaiFor(cache, { name: "zzz" }), null);
    assert.equal(models.civitaiFor(null, { name: "zzz" }), null);
});

test("models: batch Civitai fetch parses the SSE progress and done frames", async () => {
    const frames = [
        "event: progress\ndata: {\"current\":1,\"total\":2,\"model\":\"a\",\"status\":\"found\"}\n\n",
        "event: progress\ndata: {\"current\":2,\"total\":2,\"model\":\"b\",\"status\":\"not_found\"}\n\n",
        "event: done\ndata: {\"total\":2,\"found\":1,\"not_found\":1,\"errors\":0,\"hashes\":{\"a\":\"h\"},\"preview_saved\":1}\n\n",
    ].join("");
    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(typeof url === "string" ? url : url.url, "http://localhost");
        calls.push({ path: u.pathname, method: (init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : null });
        const stream = new ReadableStream({
            start(controller) {
                const enc = new TextEncoder();
                for (const f of frames) controller.enqueue(enc.encode(f));
                controller.close();
            },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const seen = [];
    const done = await api.batchCivitai("lora", ["a", "b"], (p) => seen.push(p));
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { current: 1, total: 2, model: "a", status: "found" });
    assert.equal(done.found, 1);
    assert.deepEqual(done.hashes, { a: "h" });
    assert.equal(lastCall().path, "/api/wfm/models/civitai/batch");
});

test("models: the preview URL is a plain URL builder, not a fetch", () => {
    const url = models.previewUrl("lora", "sub/dir/a.safetensors");
    assert.match(url, /^\/api\/wfm\/models\/preview\?/);
    assert.match(url, /type=lora/);
    assert.match(url, /name=sub%2Fdir%2Fa\.safetensors/);
});

test("models: applyToGenUI is a pure target description, embedding goes to the prompt", () => {
    assert.deepEqual(models.genUiTarget("checkpoint"), {
        slot: "checkpoints", inputKey: "ckpt_name", mode: "slot",
    });
    assert.equal(models.genUiTarget("embedding").mode, "prompt");
    assert.equal(models.genUiTarget("nope"), null);
});

test("models: appendEmbedding is idempotent and keeps the basename", () => {
    assert.equal(models.embeddingPromptToken("sub/dir/e.pt"), "embedding:e.pt");
    assert.equal(models.appendEmbedding("a cat", "sub/dir/e.pt"), "a cat embedding:e.pt");
    assert.equal(models.appendEmbedding("a cat embedding:e.pt", "e.pt"), "a cat embedding:e.pt");
    assert.equal(models.appendEmbedding("", "e.pt"), "embedding:e.pt");
});

test("models: decorate produces one record shape for both views", async () => {
    const rec = models.decorate("lora", "sd/x.safetensors",
        { "sd/x.safetensors": { tags: ["t"], favorite: true, memo: "m", badges: ["B"], sha256: "h" } },
        {
            disabledSet: new Set(["sd/x.safetensors"]),
            civitaiCache: { h: { type: "LORA", baseModel: "SDXL" } },
            groups: { Batch: ["sd/x.safetensors"] },
        });
    assert.equal(rec.name, "sd/x.safetensors");
    assert.equal(rec.base, "x.safetensors");
    assert.equal(rec.subdir, "sd");
    assert.equal(rec.ext, "safetensors");
    assert.equal(rec.favorite, true);
    assert.equal(rec.enabled, false);
    assert.deepEqual(rec.groups, ["Batch"]);
    assert.equal(rec.civType, "LORA");
    assert.equal(rec.baseModel, "SDXL");
    assert.match(rec.previewUrl, /type=lora/);
});

// ===========================================================================
// api — the single network layer (§2.2 rule 4)
// ===========================================================================
test("api: errors carry the HTTP status and the server message", async () => {
    routes.set("/api/wfm/models/metadata", () => json({ error: "boom" }, 500));
    await assert.rejects(
        () => models.loadMetadata(),
        (err) => {
            assert.equal(err.message, "boom");
            assert.equal(err.status, 500);
            return true;
        });
});

test("api: model listing goes through the ComfyUI client, not a bare fetch", async () => {
    // fetchCheckpoints talks to ComfyUI core, which core/client.js owns.
    routes.set("/object_info/CheckpointLoaderSimple", () =>
        json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } } } }));
    const list = await core.comfyUI.fetchCheckpoints();
    assert.deepEqual(list, ["a.safetensors"]);
});

// ===========================================================================
// guard: the modules under test really are the ones shipped
// ===========================================================================
test("guard: the core layer in this test run really is DOM-free", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../static/js/core");
    const banned = [/\bdocument\s*\./, /\bwindow\s*\./, /\bgetElementById\b/, /\bquerySelector(All)?\b/, /\binnerHTML\b/];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const re of banned) {
            assert.equal(re.test(src), false, `${f} must not match ${re}`);
        }
    }
});

test("guard: hard-coded badge colours are absent from the models helpers", () => {
    // #6366f1 was the upstream default; core must not carry a colour literal.
    assert.equal("DEFAULT_BADGE_PALETTE" in modelConstants, true);
    assert.deepEqual(modelConstants.DEFAULT_BADGE_PALETTE, {},
        "an untouched palette is empty — colours come from the user or from CSS tokens");
});

// ---------------------------------------------------------------------------
// widgets.js — /object_info derived constraints (parity item 1 depth).
// Fixture shapes copied from what ComfyUI actually returns for these nodes.
// ---------------------------------------------------------------------------
const OBJECT_INFO = {
    KSampler: {
        input: {
            required: {
                seed: ["INT", { default: 0, min: 0, max: 18446744073709551615 }],
                steps: ["INT", { default: 20, min: 1, max: 10000, step: 1 }],
                cfg: ["FLOAT", { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
                sampler_name: [["euler", "euler_ancestral", "dpmpp_2m"], {}],
                scheduler: ["COMBO", { options: ["normal", "karras"], default: "normal" }],
                denoise: ["FLOAT", { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
                model: ["MODEL", {}],
                positive: ["CONDITIONING", {}],
            },
            optional: {
                lora_name: ["COMBO", { default: "none" }],
                batch_index: ["INT", { default: 0, min: 0, max: 10000 }],
            },
        },
    },
    CLIPTextEncode: {
        input: {
            required: {
                // forceInput: a link-only socket whose type happens to be a widget type.
                text: ["STRING", { multiline: true, default: "hello" }],
                clip: ["CLIP", {}],
            },
            optional: { text_alias: ["STRING", { forceInput: true }] },
        },
    },
    LTXVEmptyLatentAudio: {
        input: {
            required: {
                // MultiType union: one widget slot, FLOAT preferred, INT also accepted.
                frame_rate: ["FLOAT,INT", { default: 25, min: 1, max: 200, step: 0.5, widgetType: "FLOAT" }],
                seconds: ["FLOAT", { default: 5, min: 0.1, max: 60 }],
                batch_size: ["INT", { default: 1, min: 1, max: 64 }],
            },
        },
    },
};

test("widgets: INT and FLOAT specs carry min/max/step/default", () => {
    const steps = widgets.inputSpec(OBJECT_INFO, "KSampler", "steps");
    assert.equal(steps.kind, "int");
    assert.equal(steps.min, 1);
    assert.equal(steps.max, 10000);
    assert.equal(steps.default, 20);

    const cfg = widgets.inputSpec(OBJECT_INFO, "KSampler", "cfg");
    assert.equal(cfg.kind, "float");
    assert.equal(cfg.step, 0.1);
    assert.equal(cfg.max, 100);
});

test("widgets: both combo shapes become an option list", () => {
    const sampler = widgets.inputSpec(OBJECT_INFO, "KSampler", "sampler_name");
    assert.equal(sampler.kind, "combo");
    assert.deepEqual(sampler.options, ["euler", "euler_ancestral", "dpmpp_2m"]);
    assert.equal(sampler.default, "euler", "an option-list combo defaults to its first choice");

    const scheduler = widgets.inputSpec(OBJECT_INFO, "KSampler", "scheduler");
    assert.equal(scheduler.kind, "combo");
    assert.deepEqual(scheduler.options, ["normal", "karras"]);
    assert.equal(scheduler.default, "normal");

    // A COMBO with no enumerable choices is still a combo, just without options.
    const lora = widgets.inputSpec(OBJECT_INFO, "KSampler", "lora_name");
    assert.equal(lora.kind, "combo");
    assert.equal(lora.options, null);
});

test("widgets: link-only inputs have no widget spec", () => {
    assert.equal(widgets.inputSpec(OBJECT_INFO, "KSampler", "model"), null);
    assert.equal(widgets.inputSpec(OBJECT_INFO, "KSampler", "positive"), null);
    assert.equal(widgets.inputSpec(OBJECT_INFO, "CLIPTextEncode", "clip"), null);
    // forceInput wins over the widget-looking type, otherwise a link socket gets a field.
    assert.equal(widgets.inputSpec(OBJECT_INFO, "CLIPTextEncode", "text_alias"), null);
});

test("widgets: STRING keeps the multiline hint", () => {
    const text = widgets.inputSpec(OBJECT_INFO, "CLIPTextEncode", "text");
    assert.equal(text.kind, "string");
    assert.equal(text.multiline, true);
    assert.equal(text.default, "hello");
});

test("widgets: a MultiType declaration occupies one widget slot", () => {
    // Exact-matching "FLOAT,INT" against the type set would drop frame_rate and shift
    // batch_size into its position — the bug upstream documents for this node.
    assert.equal(widgets.widgetKindOf("FLOAT,INT"), "FLOAT");
    const frameRate = widgets.inputSpec(OBJECT_INFO, "LTXVEmptyLatentAudio", "frame_rate");
    assert.equal(frameRate.kind, "float");
    assert.equal(frameRate.step, 0.5);

    const names = widgets.widgetNames(OBJECT_INFO, "LTXVEmptyLatentAudio");
    assert.deepEqual(names, ["frame_rate", "seconds", "batch_size"]);
});

test("widgets: widgetNames is schema order, required before optional", () => {
    const ks = widgets.widgetNames(OBJECT_INFO, "KSampler");
    assert.deepEqual(ks, ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "lora_name", "batch_index"],
        "MODEL/CONDITIONING sockets are links, not widgets, so they must not appear");

    const clip = widgets.widgetNames(OBJECT_INFO, "CLIPTextEncode");
    assert.deepEqual(clip, ["text"]);
});

test("widgets: unknown classes and inputs return null instead of throwing", () => {
    assert.equal(widgets.inputSpec(OBJECT_INFO, "NoSuchNode", "steps"), null);
    assert.equal(widgets.inputSpec(OBJECT_INFO, "KSampler", "nope"), null);
    assert.equal(widgets.inputSpec(null, "KSampler", "steps"), null);
    assert.deepEqual(widgets.widgetNames(undefined, "KSampler"), []);
});

test("widgets: widgetKindOf resolves the declared shapes ComfyUI emits", () => {
    assert.equal(widgets.widgetKindOf("INT"), "INT");
    assert.equal(widgets.widgetKindOf("int"), "INT", "lower-case declarations still resolve");
    assert.equal(widgets.widgetKindOf(["a", "b"]), "COMBO");
    assert.equal(widgets.widgetKindOf("COMFY_DYNAMICCOMBO_V3"), "COMFY_DYNAMICCOMBO_V3");
    assert.equal(widgets.widgetKindOf("LATENT"), null);
    assert.equal(widgets.widgetKindOf("INT,LATENT"), "INT");
    assert.equal(widgets.widgetKindOf(null), null);
});

// ===========================================================================
// lora.js — story storyboard (`LN*.txt`) matching + injection (parity item 4)
// ===========================================================================
const MATCHED = [
    { name: "charA.safetensors", active: true, strength_model: 1, strength_clip: 1 },
    { name: "styleB.safetensors", active: false, strength_model: 0.8, strength_clip: 0.8 },
    { name: "charC.safetensors", active: true, strength_model: 0.6, strength_clip: 0.7 },
];

test("lora: the apply payload carries only the active matches", () => {
    const payload = lora.buildApplyPayload({ "1": { class_type: "KSampler" } }, MATCHED);
    assert.deepEqual(payload.active_loras.map((l) => l.name), ["charA.safetensors", "charC.safetensors"]);
});

test("lora: an all-inactive selection never reaches the backend", async () => {
    routes.set("/api/wfm/lora/apply", () => json({ applied_count: 1 }));
    const workflow = { "1": { class_type: "KSampler", inputs: {} } };
    const res = await lora.applyLoras(workflow, [{ name: "x.safetensors", active: false }]);
    assert.equal(res.appliedCount, 0);
    assert.equal(res.workflow, workflow, "the untouched workflow is handed back");
    assert.equal(callsTo("/api/wfm/lora/apply").length, 0);
});

test("lora: apply posts {workflow, loras} and returns the rewritten workflow", async () => {
    const applied = { "7": { class_type: "LoraLoader", inputs: { lora_name: "charA.safetensors" } } };
    routes.set("/api/wfm/lora/apply", () => json({ success: true, applied_count: 2, workflow: applied }));
    const res = await lora.applyLoras({ "7": { class_type: "LoraLoader", inputs: {} } }, MATCHED);
    const call = lastCall();
    assert.equal(call.path, "/api/wfm/lora/apply");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body.loras.map((l) => l.name), ["charA.safetensors", "charC.safetensors"]);
    assert.equal(call.body.workflow["7"].class_type, "LoraLoader", "the fragment itself travels to the service");
    assert.equal(res.appliedCount, 2);
    assert.equal(res.workflow["7"].inputs.lora_name, "charA.safetensors");
});

test("lora: loadStoryContent maps the storyboard to the positive prompt", async () => {
    routes.set("/api/wfm/lora/match", ({ body }) => json({
        matched_loras: MATCHED,
        parsed_prompt: { positive_prompt: "1girl, smile", raw: body.text },
    }));
    const res = await lora.loadStoryContent("分镜 01：她笑了", { filename: "LN01.txt", autoTurbo: false });
    assert.equal(res.filename, "LN01.txt");
    assert.equal(res.positivePrompt, "1girl, smile");
    assert.equal(res.matchedLoras.length, 3);
    const call = lastCall();
    assert.equal(call.body.text, "分镜 01：她笑了");
    assert.equal(call.body.auto_turbo, false, "autoTurbo is sent under the server's snake_case key");
});

test("lora: a blank prompt clears the match without a request", async () => {
    routes.set("/api/wfm/lora/match", () => json({ matched_loras: MATCHED }));
    const res = await lora.matchLoras("   ");
    assert.deepEqual(res.matchedLoras, []);
    assert.equal(callsTo("/api/wfm/lora/match").length, 0);
});

test("lora: chip mutations match the upstream list handlers", () => {
    const loras = MATCHED.map((l) => ({ ...l }));
    lora.setLoraActive(loras, 1, true);
    assert.equal(loras[1].active, true);

    lora.setLoraWeight(loras, 0, "strength_model", "0.35");
    assert.equal(loras[0].strength_model, 0.35);
    lora.setLoraWeight(loras, 0, "strength_model", "abc");
    assert.equal(loras[0].strength_model, 0.35, "a NaN entry is ignored, as upstream's !isNaN guard did");

    lora.removeLora(loras, 0);
    assert.deepEqual(loras.map((l) => l.name), ["styleB.safetensors", "charC.safetensors"], "later rows shift up");
    lora.removeLora(loras, 99);
    assert.equal(loras.length, 2, "an out-of-range index is a no-op");
});

// ===========================================================================
// batch.js — the traversal loop (parity item 8, minus the GPU side)
// `opts.generate` is injectable precisely so the loop can be tested without a server.
// ===========================================================================
function loraBatchState(names) {
    const state = batch.createBatchState();
    batch.setActiveBatchType(state, "lora");
    const groupSet = batch.createGroupSet({ Batch: names });
    groupSet.loaded = true;
    groupSet.selected.add("Batch");
    state.modelGroups.lora = groupSet;
    return state;
}

async function withAnalysis(analysis, fn) {
    const hadWorkflow = comfyUI.currentWorkflow;
    const hadAnalysis = comfyUI.currentAnalysis;
    comfyUI.currentAnalysis = analysis;
    try {
        return await fn();
    } finally {
        comfyUI.currentAnalysis = hadAnalysis;
        comfyUI.currentWorkflow = hadWorkflow;
    }
}

const LORA_ANALYSIS = { lora_nodes: [{ id: "7", is_lora_manager: true }], checkpoint_nodes: [], sampler_nodes: [], prompt_nodes: [] };

test("batch: a 3-LoRA selection generates exactly three times", async () => {
    routes.set("/api/wfm/models/metadata", () => json({}));
    routes.set("/api/wfm/models/civitai/cache", () => json({}));
    const seen = [];
    const labels = [];
    const state = loraBatchState(["a.safetensors", "b.safetensors", "c.safetensors"]);
    const summary = await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async (opts) => { seen.push(opts); return { images: [{ src: "/view?i=1" }], seed: 42 }; },
        onItemResult: (item) => labels.push(item),
    }));
    assert.equal(summary.batchType, "lora");
    assert.equal(summary.total, 3);
    assert.equal(summary.completed, 3);
    assert.equal(summary.failed, 0);
    assert.equal(summary.aborted, false);
    assert.equal(seen.length, 3, "one generation per selected LoRA, no more");
    assert.deepEqual(labels, ["a.safetensors", "b.safetensors", "c.safetensors"]);
    assert.ok(seen.every((opts) => typeof opts.onProgress === "function"), "each item gets a progress callback");
});

test("batch: an empty selection skips with the upstream toast key", async () => {
    const state = loraBatchState([]);
    let generated = 0;
    const summary = await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async () => { generated++; return {}; },
    }));
    assert.equal(generated, 0);
    assert.equal(summary.total, 0);
    assert.equal(summary.skipped.key, "batchNoneSelected");
    assert.deepEqual(summary.skipped.args, ["LoRAs"], "the plural matches upstream's toast wording");
});

test("batch: a workflow without the required node skips before generating", async () => {
    const state = loraBatchState(["a.safetensors"]);
    const summary = await withAnalysis({ lora_nodes: [] }, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async () => ({}),
    }));
    assert.equal(summary.skipped.key, "modelsGenUINoNode");
    assert.deepEqual(summary.skipped.args, ["LoRA"]);
    assert.equal(summary.total, 0);
});

test("batch: each item rewrites the workflow before its own generation", async () => {
    routes.set("/api/wfm/models/metadata", () => json({}));
    routes.set("/api/wfm/models/civitai/cache", () => json({}));
    const snapshots = [];
    const state = loraBatchState(["a.safetensors", "b.safetensors", "c.safetensors"]);
    const workflow = { "7": { class_type: "LoraManager", inputs: {} } };
    const summary = await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow,
        generate: async (opts) => { snapshots.push(JSON.stringify(opts.workflow["7"].inputs)); return { images: [], seed: 1 }; },
    }));
    assert.equal(summary.completed, 3);
    assert.equal(snapshots.length, 3);
    assert.notEqual(snapshots[0], "{}", "the applier must write the first LoRA into the node before generating");
    assert.equal(new Set(snapshots).size, 3, "each item gets its own workflow state, not the same one three times");
});

test("batch: an explicit failure path counts the failed item", async () => {
    routes.set("/api/wfm/models/metadata", () => json({}));
    routes.set("/api/wfm/models/civitai/cache", () => json({}));
    const errors = [];
    let calls = 0;
    const state = loraBatchState(["a.safetensors", "b.safetensors"]);
    const summary = await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async () => { calls++; if (calls === 2) throw new Error("boom"); return { images: [], seed: 1 }; },
        onItemError: (item, err, index, total) => errors.push({ item, message: err.message, index, total }),
    }));
    assert.equal(summary.total, 2);
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 1);
    assert.deepEqual(errors, [{ item: "b.safetensors", message: "boom", index: 2, total: 2 }]);
});

test("batch: abort stops the loop and the summary says so", async () => {
    routes.set("/api/wfm/models/metadata", () => json({}));
    routes.set("/api/wfm/models/civitai/cache", () => json({}));
    let started = 0;
    const state = loraBatchState(["a.safetensors", "b.safetensors", "c.safetensors"]);
    const summary = await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async () => { started++; return { images: [], seed: 1 }; },
        onItemResult: () => { batch.abortBatch(state, { interrupt: false }); },
    }));
    assert.equal(started, 1, "the loop must not start a second item after the abort");
    assert.equal(summary.completed, 1);
    assert.equal(summary.aborted, true);
    assert.equal(summary.total, 3, "the total still reports the planned work");
});

test("batch: a pause holds the loop until it is resumed", async () => {
    routes.set("/api/wfm/models/metadata", () => json({}));
    routes.set("/api/wfm/models/civitai/cache", () => json({}));
    const phases = [];
    let resumed = false;
    const state = loraBatchState(["a.safetensors", "b.safetensors"]);
    const summary = await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async () => ({ images: [], seed: 1 }),
        onStatus: (evt) => phases.push(evt.phase),
        onItemResult: (item) => {
            if (item === "a.safetensors" && !resumed) {
                resumed = true;
                batch.pauseBatch(state);
                setTimeout(() => batch.resumeBatch(state), 5);
            }
        },
    }));
    assert.equal(summary.completed, 2);
    assert.ok(phases.includes("paused"), "the pause phase is reported before the gate releases");
    assert.equal(phases[phases.length - 1], "done");
});

test("batch: seed mode and story loras are forwarded to every generation", async () => {
    routes.set("/api/wfm/models/metadata", () => json({}));
    routes.set("/api/wfm/models/civitai/cache", () => json({}));
    const seen = [];
    const story = [{ name: "story.safetensors", active: true }];
    const state = loraBatchState(["a.safetensors", "b.safetensors"]);
    await withAnalysis(LORA_ANALYSIS, () => batch.runBatchGenerate(state, {
        workflow: { "7": { class_type: "LoraManager", inputs: {} } },
        generate: async (opts) => { seen.push(opts); return { images: [], seed: 1 }; },
        seedMode: "increment",
        seedValue: 7,
        storyLoras: story,
        autoInjectLoras: true,
    }));
    assert.equal(seen.length, 2);
    assert.ok(seen.every((o) => o.seedMode === "increment" && o.seedValue === 7));
    assert.ok(seen.every((o) => o.storyLoras === story && o.autoInjectLoras === true));
});

test("batch: a sampler run writes each value into the KSampler and keeps the last", async () => {
    const state = batch.createBatchState();
    batch.setActiveBatchType(state, "sampler");
    batch.setSimpleItems(state, "samplers", ["dpmpp_2m", "euler", "euler_ancestral"]);
    for (const name of ["euler", "dpmpp_2m", "euler_ancestral"]) state.samplers.selected.add(name);
    const workflow = { "3": { class_type: "KSampler", inputs: { sampler_name: "euler" } } };
    const seen = [];
    const summary = await withAnalysis({ ...LORA_ANALYSIS, sampler_nodes: [{ id: "3" }] }, () => batch.runBatchGenerate(state, {
        workflow,
        generate: async (opts) => { seen.push(opts.workflow["3"].inputs.sampler_name); return { images: [], seed: 1 }; },
    }));
    assert.deepEqual(seen, ["dpmpp_2m", "euler", "euler_ancestral"], "the selection is traversed in sorted order");
    assert.equal(summary.completed, 3);
    assert.equal(workflow["3"].inputs.sampler_name, "euler_ancestral", "sampler batches leave the last value applied, like upstream");
});

// ===========================================================================
// gen presets (parity item 7)
// ===========================================================================
test("presets: list, save, apply and delete hit the documented routes", async () => {
    routes.set("/api/wfm/gen_presets", ({ init }) => json(
        (init.method || "GET") === "GET" ? [{ id: "p1", name: "Anima 20" }] : { status: "ok", preset: { id: "p1" } },
    ));
    routes.set("/api/wfm/gen_presets/apply", () => json({ status: "ok", preset: { id: "p1" }, workflow: { "3": { inputs: { steps: 20 } } } }));
    routes.set("/api/wfm/gen_presets/p1", () => json({ status: "ok", deleted: "p1" }));

    const list = await api.listGenPresets();
    assert.deepEqual(list, [{ id: "p1", name: "Anima 20" }]);
    assert.equal(callsTo("/api/wfm/gen_presets")[0].method, "GET");

    await api.saveGenPreset({ id: "p1", name: "Anima 20", steps: 20, cfg: 7 });
    const saved = callsTo("/api/wfm/gen_presets").at(-1);
    assert.equal(saved.method, "POST");
    assert.deepEqual(saved.body, { id: "p1", name: "Anima 20", steps: 20, cfg: 7 }, "the preset is forwarded verbatim");

    const applied = await api.applyGenPreset({ workflow: { "3": { inputs: {} } }, preset_id: "p1" });
    assert.equal(applied.workflow["3"].inputs.steps, 20, "the sampler parameters come back on the workflow");
    assert.equal(lastCall().path, "/api/wfm/gen_presets/apply");

    await api.deleteGenPreset("p1");
    assert.equal(lastCall().path, "/api/wfm/gen_presets/p1");
    assert.equal(lastCall().method, "DELETE");
});
