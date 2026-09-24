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
const { wildcard, style, models, settings, api, modelConstants, modelConstants: MC, widgets, lora, batch, comfyUI, image } = core;

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

// Keep this test above every `setCachedStyles` call below: `resolveStyleByName` only fetches
// while the module-level catalog is still null (upstream `_stylesData` had no reset either),
// so once a test primes it the lazy path can never be observed again.
test("style: resolving a name loads the catalog once and caches it", async () => {
    routes.set("/api/wfm/styles", () => json(CATALOG));
    const found = await style.resolveStyleByName("Templated");
    assert.deepEqual(found, CATALOG[1]);
    assert.equal(callsTo("/api/wfm/styles").length, 1);
    assert.deepEqual(await style.resolveStyleByName("Vivid"), CATALOG[0]);
    assert.equal(callsTo("/api/wfm/styles").length, 1, "the second resolve must hit the cache");
    assert.deepEqual(style.getCachedStyles(), CATALOG);
    assert.equal(await style.resolveStyleByName(""), null, "an empty name never reaches the server");
    assert.equal(callsTo("/api/wfm/styles").length, 1);
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
// ===========================================================================
// pipeline.js — the generation orchestrator (parity item 3's submission half).
// `comfyUI` is a plain object literal upstream, so generate/interrupt are
// replaceable here; nothing in these tests touches a real ComfyUI.
// ===========================================================================
const { pipeline } = core;
const { comfyWorkflow } = core;
const WORKFLOW_FIXTURE = {
    "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20 } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "original positive" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "original negative" } },
};
const ANALYSIS_FIXTURE = {
    prompt_nodes: [{ id: "5", role: "positive" }, { id: "6", role: "negative" }],
    sampler_nodes: [{ id: "3" }],
};

function withClient(stubs, fn) {
    const keys = ["currentWorkflow", "currentAnalysis", "generating", "generate", "interrupt"];
    const saved = Object.fromEntries(keys.map((k) => [k, comfyUI[k]]));
    Object.assign(comfyUI, { currentWorkflow: null, currentAnalysis: null, generating: false, interrupt: async () => {}, ...stubs });
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            for (const k of keys) comfyUI[k] = saved[k];
        });
}

test("pipeline: seed options follow the upstream field semantics", () => {
    assert.deepEqual(pipeline.resolveSeedOptions("random", null), { seedMode: "random", seedValue: -1 });
    assert.deepEqual(pipeline.resolveSeedOptions(undefined, 7), { seedMode: "fixed", seedValue: 7 }, "an explicit value forces fixed");
    assert.deepEqual(pipeline.resolveSeedOptions(undefined, undefined), { seedMode: "random", seedValue: -1 });
});

test("pipeline: the prompt override writes only the analysed text nodes", () => {
    const wf = JSON.parse(JSON.stringify(WORKFLOW_FIXTURE));
    pipeline.applyPromptOverride(wf, ANALYSIS_FIXTURE, { prompt: "a girl", negative: "bad hands" });
    assert.equal(wf["5"].inputs.text, "a girl");
    assert.equal(wf["6"].inputs.text, "bad hands");
    assert.equal(wf["3"].inputs.steps, 20, "the sampler is untouched");

    pipeline.applyPromptOverride(wf, ANALYSIS_FIXTURE, { prompt: null, negative: undefined });
    assert.equal(wf["5"].inputs.text, "a girl", "null means leave-as-is, not clear-the-field");

    const keyed = { "9": { inputs: { text1: "x" } } };
    pipeline.applyPromptOverride(keyed, { prompt_nodes: [{ id: "9", role: "positive", textKey: "text1" }] }, { prompt: "via textKey" });
    assert.equal(keyed["9"].inputs.text1, "via textKey");
});

test("pipeline: a run returns the frozen contract and leaves the caller's workflow alone", () => {
    const caller = JSON.parse(JSON.stringify(WORKFLOW_FIXTURE));
    return withClient({
        currentWorkflow: caller,
        currentAnalysis: ANALYSIS_FIXTURE,
        generate: async (wf, options) => {
            assert.equal(wf["5"].inputs.text, "typed prompt", "the prompt override reaches the queue");
            assert.equal(options.seedMode, "fixed");
            assert.equal(options.seedValue, 123);
            assert.equal(options.timeoutMs, undefined, "a still-image run keeps the client default timeout");
            assert.equal(typeof options.onProgress, "function");
            return { images: [{ type: "output", filename: "a_0001.png" }], seed: 123, svgOutputs: [] };
        },
    }, async () => {
        const seen = [];
        const res = await pipeline.runGeneration({
            workflow: caller,
            prompt: "typed prompt",
            seedValue: 123,
            onProgress: (pct, msg) => seen.push([pct, msg]),
        });
        assert.deepEqual(Object.keys(res).sort(), ["images", "seed", "svgOutputs", "workflow"]);
        assert.equal(res.seed, 123);
        assert.equal(res.images.length, 1);
        assert.equal(res.workflow["5"].inputs.text, "typed prompt");
        assert.equal(caller["5"].inputs.text, "original positive", "the caller's object is never mutated");
        assert.equal(seen[0][0], 0);
        assert.equal(seen[seen.length - 1][0], 1);
        assert.match(seen[seen.length - 1][1], /Done \(1 image\)/);
    });
});

test("pipeline: a video analysis swaps in the 30 minute timeout", () => {
    const isVideo = comfyWorkflow.isVideoWorkflow;
    comfyWorkflow.isVideoWorkflow = () => true;
    return withClient({
        currentWorkflow: WORKFLOW_FIXTURE,
        currentAnalysis: ANALYSIS_FIXTURE,
        generate: async (_wf, options) => {
            assert.equal(options.timeoutMs, 30 * 60 * 1000);
            return { images: [], seed: 1 };
        },
    }, async () => {
        const res = await pipeline.runGeneration({ workflow: WORKFLOW_FIXTURE });
        assert.deepEqual(res.images, []);
        assert.deepEqual(res.svgOutputs, [], "a missing svgOutputs still normalises to []");
        comfyWorkflow.isVideoWorkflow = isVideo;
    }).finally(() => { comfyWorkflow.isVideoWorkflow = isVideo; });
});

test("pipeline: refuses to start without a workflow or while one is running", async () => {
    await assert.rejects(
        withClient({ currentWorkflow: null, generate: async () => ({}) }, () => pipeline.runGeneration({})),
        /no workflow loaded/,
    );
    await assert.rejects(
        withClient({
            currentWorkflow: WORKFLOW_FIXTURE,
            generating: true,
            generate: async () => ({})
        }, () => pipeline.runGeneration({ workflow: WORKFLOW_FIXTURE })),
        /already running/,
    );
});

test("pipeline: an abort interrupts the server and normalises the error to AbortError", async () => {
    let interrupted = 0;
    const controller = new AbortController();
    await withClient({
        currentWorkflow: WORKFLOW_FIXTURE,
        currentAnalysis: ANALYSIS_FIXTURE,
        interrupt: async () => { interrupted++; },
        generate: async () => {
            controller.abort();
            // what ComfyUI reports when the interrupt lands mid-run
            throw new Error("Execution interrupted");
        },
    }, async () => {
        await assert.rejects(
            pipeline.runGeneration({ workflow: WORKFLOW_FIXTURE, signal: controller.signal }),
            (err) => err.name === "AbortError" && /interrupted/i.test(err.message),
            "a user abort must be distinguishable from a real failure",
        );
    });
    assert.equal(interrupted, 1, "comfyUI.interrupt() is what stops the queue server-side");
});

test("pipeline: an already-aborted signal never reaches the queue", async () => {
    let generated = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        withClient({
            currentWorkflow: WORKFLOW_FIXTURE,
            generate: async () => { generated++; return {}; },
        }, () => pipeline.runGeneration({ workflow: WORKFLOW_FIXTURE, signal: controller.signal })),
        (err) => err.name === "AbortError",
    );
    assert.equal(generated, 0);
});

test("pipeline: a failing LoRA auto-inject warns and the generation continues", async () => {
    routes.set("/api/wfm/lora/apply", () => json({ error: "service down" }, 500));
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
        await withClient({
            currentWorkflow: WORKFLOW_FIXTURE,
            currentAnalysis: ANALYSIS_FIXTURE,
            generate: async () => ({ images: [{ filename: "x.png" }], seed: 5 }),
        }, async () => {
            const res = await pipeline.runGeneration({
                workflow: WORKFLOW_FIXTURE,
                storyLoras: [{ name: "a.safetensors", active: true }],
            });
            assert.equal(res.seed, 5, "an inject failure is upstream behaviour: warn, then generate anyway");
        });
        assert.equal(warned, 1);
    } finally {
        console.warn = warn;
    }
});

test("pipeline: a style is applied before wildcards expand", async () => {
    // The catalog is primed rather than stubbed: `resolveStyleByName` answers from core/style.js's
    // module-level cache, and by this point in the file the style block has already filled it, so a
    // `/api/wfm/styles` handler would never be reached.
    const previousStyles = style.getCachedStyles();
    style.setCachedStyles([{ name: "ordering", prompt: "masterpiece, __qual__", negative_prompt: "" }]);
    routes.set("/api/wfm/wildcards/content", ({ url }) => json(
        url.searchParams.get("filename") === "qual.txt" ? { content: "hd\n4k" } : { content: "" },
    ));
    wildcard.clearWildcardCache("qual");
    try {
        await withClient({
            currentWorkflow: WORKFLOW_FIXTURE,
            currentAnalysis: ANALYSIS_FIXTURE,
            generate: async (wf) => {
                assert.match(wf["5"].inputs.text, /^original positive, masterpiece, /, "the style appends to the node text");
                assert.doesNotMatch(wf["5"].inputs.text, /__qual__/, "the token the style introduced was expanded too");
                assert.match(wf["5"].inputs.text, /^original positive, masterpiece, (hd|4k)$/, "exactly one line replaced the token");
                assert.equal(wf["6"].inputs.text, "original negative", "an empty negative_prompt appends nothing");
                return { images: [], seed: 1 };
            },
        }, () => pipeline.runGeneration({ workflow: WORKFLOW_FIXTURE, styleName: "ordering" }));
    } finally {
        style.setCachedStyles(previousStyles);
        wildcard.clearWildcardCache("qual");
    }
});
// ===========================================================================
// image — the "results metadata" half of parity row 9 and Models item 10
// ===========================================================================
test("image: the output directory is normalised the way every upstream writer did", () => {
    assert.equal(image.normalizeOutputDir("D:\\ComfyUI\\output\\"), "D:/ComfyUI/output");
    assert.equal(image.normalizeOutputDir("/out//"), "/out/");
    assert.equal(image.normalizeOutputDir(""), "");
    assert.equal(image.normalizeOutputDir(undefined), "");
});

test("image: fetchOutputDir reads /settings/output-dir and degrades to an empty string", async () => {
    routes.set("/api/wfm/settings/output-dir", () => json({ current: "D:\\Library\\output\\", default: "/d", saved: "x" }));
    assert.equal(await image.fetchOutputDir(), "D:/Library/output");
    routes.set("/api/wfm/settings/output-dir", () => json({ error: "boom" }, 500));
    assert.equal(await image.fetchOutputDir(), "", "upstream swallowed the failure so the caller keeps its old value");
});

test("image: only saved outputs get metadata, and the failing ones are counted not thrown", async () => {
    const posts = [];
    routes.set("/api/wfm/settings/output-dir", () => json({ current: "/out" }));
    routes.set("/wfm/gallery/image/meta", ({ body }) => {
        posts.push(body);
        return body.path.includes("bad") ? json({ error: "disk full" }, 500) : json({ status: "ok" });
    });
    const workflow = { "3": { class_type: "KSampler", inputs: {} } };
    const res = await image.saveGeneratedImagesMeta([
        { filename: "a.png", subfolder: "seed", type: "output" },
        { filename: "preview.png", type: "temp" },
        { filename: "bad.png", type: "output" },
    ], workflow);
    assert.deepEqual(res, { saved: 1, failed: 1 }, "never rejects, but says what happened");
    assert.equal(posts.length, 2, "the `temp` preview is not a saved artifact");
    assert.deepEqual(posts.map((p) => p.path), ["/out/seed/a.png", "/out/bad.png"]);
    assert.deepEqual(posts[0].workflow, workflow, "the payload key is `workflow`");
    assert.equal(callsTo("/api/wfm/settings/output-dir").length, 1, "fetched once, then reused for every image");
});

test("image: with no output directory at all, not a single metadata request is made", async () => {
    routes.set("/api/wfm/settings/output-dir", () => json({ error: "gone" }, 500));
    const res = await image.saveGeneratedImagesMeta([{ filename: "a.png", type: "output" }], {});
    assert.deepEqual(res, { saved: 0, failed: 0 });
    assert.deepEqual(callsTo("/wfm/gallery/image/meta"), []);
});

test("image: the default checkpoint replaces only checkpoint loaders", async () => {
    const settingsRoutes = (payload) => routes.set("/api/wfm/settings", () => json(payload));
    const wf = () => ({
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "old.safetensors" } },
        "2": { class_type: "Checkpoint Loader", inputs: { ckpt_name: "old.safetensors" } },
        "3": { class_type: "ImageMetadataPromptLoader", inputs: { ckpt_name: "old.safetensors" } },
        "4": { class_type: "LoraLoader", inputs: { lora_name: "keepme" } },
    });
    settingsRoutes({ default_checkpoint_enabled: false, default_checkpoint_name: "new.safetensors" });
    const workflow = wf();
    assert.equal(await image.applyDefaultCheckpointIfEnabled(workflow), null);
    assert.equal(workflow["1"].inputs.ckpt_name, "old.safetensors", "disabled means untouched");

    settingsRoutes({ default_checkpoint_enabled: true, default_checkpoint_name: "new.safetensors" });
    const workflow2 = wf();
    assert.equal(await image.applyDefaultCheckpointIfEnabled(workflow2), "new.safetensors");
    assert.deepEqual([workflow2["1"], workflow2["2"], workflow2["3"]].map((n) => n.inputs.ckpt_name),
        ["new.safetensors", "new.safetensors", "new.safetensors"]);
    assert.equal(workflow2["4"].inputs.lora_name, "keepme", "a LoRA node is not a checkpoint loader");

    routes.set("/api/wfm/settings", () => json({ error: "down" }, 500));
    assert.equal(await image.applyDefaultCheckpointIfEnabled(wf()), null, "a server error is not fatal");
});

test("image: blobToDataUrl matches the platform base64 encoder including padding", async () => {
    for (const bytes of [[0xff], [0x00, 0x10], [1, 2, 3], [72, 101, 108, 108, 111]]) {
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const expected = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
        assert.equal(await image.blobToDataUrl(blob), expected, `bytes ${bytes}`);
    }
    const untyped = new Blob([new Uint8Array([1, 2, 3])]);
    assert.match(await image.blobToDataUrl(untyped), /^data:application\/octet-stream;base64,/);
});

test("image: flattenFolderTree labels the root and walks children depth-first", () => {
    const flat = image.flattenFolderTree({
        path: "", abs_path: "/out", children: [
            { path: "a", abs_path: "/out/a", children: [{ path: "a/b", abs_path: "/out/a/b" }] },
            { path: "c", abs_path: "/out/c" },
        ],
    });
    assert.deepEqual(flat.map((n) => n.path), ["[root]", "a", "a/b", "c"]);
    assert.equal(flat[1].abs_path, "/out/a");
});

// ===========================================================================
// client — the `/prompt` + WebSocket half of parity row 3. `core/client.js` is a bare
// re-export of upstream `static/js/comfyui-client.js` (A1 keeps it byte-identical), so
// these tests pin the contract our own pipeline.js and batch.js are built on: what
// `generate()` sends, what it resolves with, and how every failure mode surfaces.
// ===========================================================================
class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static last = null;

    constructor(url = "ws://test/ws?clientId=x") {
        this.url = url;
        // CONNECTING first: `connectWebSocket()` only wires onopen/onclose on the socket it builds
        // itself, and the disconnect path under test needs that wiring to be real.
        this.readyState = FakeSocket.CONNECTING;
        this.listeners = new Map();
        FakeSocket.last = this;
        queueMicrotask(() => this.fireOpen());
    }

    fireOpen() {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
        this.emit("open", "");
    }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn));
    }

    close() {
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.();
    }

    emit(type, payload) {
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        for (const fn of [...(this.listeners.get(type) || [])]) fn({ data });
    }
}

const PID = "pid-1";

function stubComfyServer(outputs) {
    routes.set("/prompt", () => json({ prompt_id: PID, number: 1, node_errors: {} }));
    routes.set(`/history/${PID}`, () => json({ [PID]: { outputs } }));
}

const ONE_IMAGE = { "9": { images: [{ filename: "a.png", subfolder: "s", type: "output" }] } };

async function withComfy(socket, fn) {
    const keys = ["socket", "baseUrl", "wsUrl", "generating", "currentPromptId", "connected"];
    const saved = Object.fromEntries(keys.map((k) => [k, comfyUI[k]]));
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket;
    Object.assign(comfyUI, { socket, baseUrl: "", wsUrl: "ws://test", generating: false, currentPromptId: null, connected: true });
    try {
        return await fn();
    } finally {
        for (const k of keys) comfyUI[k] = saved[k];
        comfyUI._pendingTrackers.clear();
        if (savedWS === undefined) delete globalThis.WebSocket;
        else globalThis.WebSocket = savedWS;
    }
}

/** Wait until trackProgress() has attached, so a message cannot be emitted into the gap. */
async function awaitTracker() {
    for (let i = 0; i < 500 && comfyUI._pendingTrackers.size === 0; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(comfyUI._pendingTrackers.size > 0, "the prompt tracker is registered before messages are sent");
}

test("client: generate() posts /prompt with the client id and the workflow as extra_pnginfo", () => {
    const socket = new FakeSocket();
    stubComfyServer(ONE_IMAGE);
    const wf = { "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20 } } };
    return withComfy(socket, async () => {
        const p = comfyUI.generate(wf, { seedMode: "fixed", seedValue: 777 });
        await awaitTracker();
        socket.emit("message", { type: "executing", data: { prompt_id: PID, node: null } });
        const res = await p;
        const post = callsTo("/prompt")[0];
        assert.equal(post.method, "POST");
        assert.equal(post.body.client_id, comfyUI.clientId);
        assert.equal(post.body.prompt["3"].class_type, "KSampler", "the API graph is what is queued");
        assert.equal(post.body.extra_data.extra_pnginfo.workflow["3"].inputs.seed, 777,
            "SaveImage embeds the executed workflow, seed included, into the PNG");
        assert.deepEqual(res.images, [{ filename: "a.png", subfolder: "s", type: "output" }]);
        assert.equal(res.seed, 777);
        assert.deepEqual(res.svgOutputs, [], "no Save SVG String node means an empty list, not undefined");
        assert.equal(comfyUI.currentPromptId, PID);
        assert.equal(comfyUI.generating, false, "the flag is cleared on the success path too");
    });
});

test("client: the seed is stamped in place into seed and noise_seed", () => {
    const socket = new FakeSocket();
    stubComfyServer({});
    const wf = {
        "3": { class_type: "KSampler", inputs: { seed: 0, noise_seed: 1, steps: 20 } },
        "4": { class_type: "EmptyLatentImage", inputs: { batch_size: 1 } },
    };
    return withComfy(socket, async () => {
        const p = comfyUI.generate(wf, { seedMode: "fixed", seedValue: 4242 });
        await awaitTracker();
        socket.emit("message", { type: "executing", data: { prompt_id: PID, node: null } });
        const res = await p;
        assert.equal(res.seed, 4242);
        assert.deepEqual(res.images, [], "a history with no outputs is a clean run, not an error");
        assert.equal(wf["3"].inputs.seed, 4242);
        assert.equal(wf["3"].inputs.noise_seed, 4242, "both spellings get the same seed");
        assert.equal(wf["4"].inputs.batch_size, 1, "nodes without a seed are untouched");
    });
});

test("client: random seed mode ignores the supplied value and picks one", () => {
    const socket = new FakeSocket();
    stubComfyServer(ONE_IMAGE);
    return withComfy(socket, async () => {
        const p = comfyUI.generate({ "3": { inputs: { seed: 5 } } }, { seedMode: "random", seedValue: 999 });
        await awaitTracker();
        socket.emit("message", { type: "executing", data: { prompt_id: PID, node: null } });
        const res = await p;
        assert.notEqual(res.seed, 999);
        assert.ok(Number.isInteger(res.seed) && res.seed >= 0, `got ${res.seed}`);
        assert.equal(res.images.length, 1);
    });
});

test("client: progress messages reach the callback as value/max, other prompts are ignored", () => {
    const socket = new FakeSocket();
    stubComfyServer(ONE_IMAGE);
    const seen = [];
    return withComfy(socket, async () => {
        const p = comfyUI.generate({ "3": { inputs: {} } }, { onProgress: (pct) => seen.push(pct) });
        await awaitTracker();
        socket.emit("message", { type: "progress", data: { prompt_id: "someone-else", value: 9, max: 10 } });
        socket.emit("message", { type: "progress", data: { prompt_id: PID, value: 1, max: 10 } });
        socket.emit("message", { type: "progress", data: { prompt_id: PID, value: 7, max: 10 } });
        assert.deepEqual(seen, [0.1, 0.7], "only our own prompt drives the bar");
        socket.emit("message", { type: "executing", data: { prompt_id: "someone-else", node: null } });
        assert.equal(comfyUI._pendingTrackers.size, 1, "another job finishing must not resolve ours");
        socket.emit("message", { type: "executing", data: { prompt_id: PID, node: "5" } });
        assert.equal(comfyUI._pendingTrackers.size, 1, "a mid-run node is not the end");
        socket.emit("message", { type: "executing", data: { prompt_id: PID, node: null } });
        await p;
        assert.equal(comfyUI._pendingTrackers.size, 0, "the tracker is removed once settled");
    });
});

test("client: a malformed or unknown message shape cannot settle the run", async () => {
    const socket = new FakeSocket();
    stubComfyServer(ONE_IMAGE);
    await withComfy(socket, async () => {
        const p = comfyUI.generate({ "3": { inputs: {} } });
        p.catch(() => { /* the abort below is the expected end */ });
        await awaitTracker();
        socket.emit("message", "not json at all");
        socket.emit("message", { type: "progress", data: { prompt_id: PID, max: 0 } });
        socket.emit("message", { type: "status", data: { status: {} } });
        assert.equal(comfyUI._pendingTrackers.size, 1, "none of the above resolves or rejects the promise");
        socket.emit("message", { type: "execution_error", data: { prompt_id: PID, exception_message: "CUDA out of memory" } });
        await assert.rejects(p, /CUDA out of memory/);
    });
});

test("client: an interrupt and a dropped socket both reject a hanging run", async () => {
    for (const [label, expected, drop] of [
        ["execution_interrupted", /Execution interrupted/, false],
        ["websocket close", /WebSocket disconnected/, true],
    ]) {
        stubComfyServer(ONE_IMAGE);
        // null = let connectWebSocket() build the socket, so its onclose wiring is the real one.
        await withComfy(null, async () => {
            const p = comfyUI.generate({ "3": { inputs: {} } });
            await awaitTracker();
            const socket = FakeSocket.last;
            assert.ok(socket instanceof FakeSocket, "the client opened the connection itself");
            if (drop) socket.close();
            else socket.emit("message", { type: "execution_interrupted", data: { prompt_id: PID } });
            await assert.rejects(p, expected, `${label} must surface as a rejection`);
            assert.equal(comfyUI.generating, false, "and the busy flag must not stay set");
            assert.equal(comfyUI._pendingTrackers.size, 0, "and the tracker must be dropped");
        });
    }
});

test("client: the timeout is a real safety valve, not a stuck promise", async () => {
    const socket = new FakeSocket();
    stubComfyServer(ONE_IMAGE);
    const warn = console.warn;
    console.warn = () => {};
    try {
        await withComfy(socket, async () => {
            const started = Date.now();
            const p = comfyUI.generate({ "3": { inputs: {} } }, { timeoutMs: 40 });
            await awaitTracker();
            await assert.rejects(p, (err) => /Generation timed out/.test(err.message) && err.message.includes(PID));
            assert.ok(Date.now() - started >= 35, "it waited for the window rather than failing instantly");
        });
    } finally {
        console.warn = warn;
    }
});

test("client: an HTTP rejection from /prompt carries the server's own message", async () => {
    const socket = new FakeSocket();
    routes.set("/prompt", () => json({ error: { type: "invalid_prompt", message: "No checkpoint selected" } }, 400));
    await withComfy(socket, async () => {
        await assert.rejects(
            comfyUI.generate({ "3": { inputs: {} } }),
            /No checkpoint selected/,
            "the validation error the user needs, not a bare HTTP 400",
        );
    });
});

test("client: svgOutputs repairs the character array ComfyUI hands back", async () => {
    const socket = new FakeSocket();
    stubComfyServer({
        "9": { images: [{ filename: "v.svg", type: "output" }] },
        "12": { saved_svg: ["v", ".", "s", "v", "g"], path: "/tmp/v.svg" },
    });
    await withComfy(socket, async () => {
        const p = comfyUI.generate({ "3": { inputs: {} } });
        await awaitTracker();
        socket.emit("message", { type: "executing", data: { prompt_id: PID, node: null } });
        const res = await p;
        assert.deepEqual(res.svgOutputs, [{ filename: "v.svg", path: "/tmp/v.svg" }]);
        assert.equal(res.images.length, 1, "images and svg outputs are collected independently");
    });
});

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

// ===========================================================================
// contract — the JS -> Python boundary, cross-checked against the real registrations
//
// `py/` is frozen for this refactor, so every endpoint `core/api.js` calls has to already
// exist in `py/routes/*.py`. A wrong path or method there is invisible to every other gate:
// the request throws at runtime, the calling view catches it, and the feature is just quietly
// dead. This gate reads both sides as source and matches them, no server needed.
// ===========================================================================
import { readFileSync as readFs, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMFY_CORE_PREFIXES = ["/object_info", "/prompt", "/history", "/view", "/upload", "/system_stats", "/ws"];

function backendRoutes() {
    const dir = REPO_ROOT + "py/routes";
    const routes = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".py"))) {
        const src = readFs(dir + "/" + file, "utf8");
        for (const m of src.matchAll(/add_(get|post|put|delete|route)\(\s*["']([^"']+)["']/g)) {
            routes.push({ method: m[1] === "route" ? "ANY" : m[1].toUpperCase(), path: m[2], file });
        }
    }
    return routes;
}

function frontendCalls() {
    const src = readFs(REPO_ROOT + "static/js/core/api.js", "utf8");
    const exportRe = /^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/gm;
    const found = [];
    const skipped = [];
    let match;
    while ((match = exportRe.exec(src))) {
        const start = match.index;
        const rest = src.slice(start + 1);
        const next = rest.search(/^export\s+(?:async\s+)?(?:function|const)\s+/m);
        const body = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
        for (const call of body.matchAll(/request\(\s*(["`])([^"`]*)\1/g)) {
            const path = call[2];
            const method = (body.slice(call.index, call.index + 400).match(/method:\s*"([A-Z]+)"/) || [])[1] || "GET";
            if (!path.startsWith("/")) skipped.push(`${match[1]} -> ${path}`);
            else found.push({ name: match[1], method, path });
        }
    }
    return { found, skipped };
}

function routeMatches(call, route) {
    if (route.method !== "ANY" && route.method !== call.method) return false;
    const tpl = route.path.replace(/\/$/, "").split("/").filter(Boolean);
    // A `${...}` segment on the frontend side is a wildcard, exactly like a `{name}` segment on
    // the backend side. Segment counts must still agree: matching on prefix alone would let
    // `/api/x/${id}/bogus` pass against `/api/x/{id}/status`, which is the whole point of the gate.
    const segs = call.path.replace(/\/$/, "").split("/").filter(Boolean);
    if (segs.length !== tpl.length) return false;
    return segs.every((seg, i) => /^\{.*\}$/.test(tpl[i]) || seg.includes("${") || seg === tpl[i]);
}

function auditRoutes() {
    const routes = backendRoutes();
    const { found, skipped } = frontendCalls();
    const scoped = found.filter((c) => !COMFY_CORE_PREFIXES.some((p) => c.path.startsWith(p)));
    return {
        routeCount: routes.length,
        callCount: found.length,
        skipped,
        coreScoped: found.length - scoped.length,
        methodsSeen: [...new Set(routes.map((r) => r.method))].sort(),
        unmatched: scoped.filter((c) => !routes.some((r) => routeMatches(c, r))),
    };
}

test("contract: every api.js request lands on a route py/routes actually registers", () => {
    const audit = auditRoutes();
    assert.ok(audit.routeCount >= 150, `found only ${audit.routeCount} backend registrations`);
    assert.deepEqual(audit.methodsSeen, ["DELETE", "GET", "POST", "PUT"]);
    assert.ok(audit.callCount >= 90, `only ${audit.callCount} request call sites parsed`);
    assert.deepEqual(audit.skipped, [], "no request() call may take a computed path we cannot read");
    assert.equal(audit.coreScoped, 0, "api.js is the Workflow-Studio layer; ComfyUI-core routes belong to client.js");
    assert.deepEqual(audit.unmatched, [], `${audit.unmatched.length} frontend call(s) hit a path or method the backend never registers`);
});

test("responsive: the nav rail collapses at its declared breakpoint", () => {
    const css = readFs(REPO_ROOT + "frontend/src/theme.css", "utf8");
    const blocks = [];
    const re = /@media\s+([^{]+)\{/g;
    let m;
    while ((m = re.exec(css))) {
        let depth = 1;
        let i = re.lastIndex;
        while (i < css.length && depth > 0) {
            if (css[i] === "{") depth++;
            else if (css[i] === "}") depth--;
            i++;
        }
        blocks.push({ query: m[1].trim(), body: css.slice(re.lastIndex, i - 1) });
    }
    const byQuery = (needle) => blocks.find((b) => b.query.includes(needle));
    const compact = byQuery("max-width: 839px");
    assert.ok(compact, "the 839px rail collapse is gone from the stylesheet");
    assert.match(compact.body, /\.nu-rail__label\s*\{[^}]*display:\s*none/, "labels are what collapses");
    assert.match(compact.body, /\.nu-rail__icon\s*\{[^}]*width:\s*48px/, "the icon tile grows to the M3 48dp target");
    assert.match(compact.body, /--nu-rail-width:\s*56px/, "and the grid column narrows with it");

    const baseLabelRule = css.match(/\.nu-rail__label\s*\{[^}]*\}/);
    assert.ok(baseLabelRule, "the base .nu-rail__label rule is missing");
    assert.doesNotMatch(baseLabelRule[0], /display:\s*none/,
        "labels must be visible by default, or the breakpoint hides nothing");
    assert.match(css, /\.nu-app\s*\{[^}]*display:\s*grid/, "the shell is a grid, so the rail width drives the content column");
    assert.ok(byQuery("max-width: 1100px"), "the intermediate breakpoint the card grids rely on is missing");
    assert.ok(byQuery("prefers-reduced-motion"), "the reduced-motion block A5e confines !important to");
});

test("contract: the route gate is armed and can go red", () => {
    const routes = backendRoutes();
    assert.equal(routeMatches({ method: "GET", path: "/api/wfm/settings" }, { method: "GET", path: "/api/wfm/settings" }), true);
    assert.equal(routeMatches({ method: "POST", path: "/api/wfm/settings" }, { method: "GET", path: "/api/wfm/settings" }), false,
        "a flipped method must not match");
    assert.equal(routeMatches({ method: "GET", path: "/api/wfm/settins" }, { method: "GET", path: "/api/wfm/settings" }), false,
        "a typo must not match");
    assert.equal(routeMatches({ method: "GET", path: "/api/wfm/models/civitai/${id}/status" }, { method: "GET", path: "/api/wfm/models/civitai/{name}/status" }), true,
        "a templated path matches on its static prefix");
    assert.equal(routeMatches({ method: "GET", path: "/api/wfm/models/civitai/${id}/bogus" }, { method: "GET", path: "/api/wfm/models/civitai/{name}/status" }), false);
    const audit = auditRoutes();
    const poisoned = [...audit.unmatched, { name: "poison", method: "POST", path: "/api/wfm/nope-does-not-exist" }];
    assert.equal(poisoned.filter((c) => !routes.some((r) => routeMatches(c, r))).length, 1,
        "an invented route survives the audit only as an unmatched entry");
});
