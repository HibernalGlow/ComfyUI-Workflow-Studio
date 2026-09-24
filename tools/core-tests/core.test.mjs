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
const { wildcard, style, models, settings, api, modelConstants, modelConstants: MC } = core;

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
