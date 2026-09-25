/**
 * tools/core-tests/workflow-convert.test.mjs
 *
 * Regression tests for `comfyWorkflow.convertUiToApi()`'s widget alignment — the one upstream
 * function every Generate load runs, and the one whose output the parity readout in
 * GenPresets.tsx shows verbatim.
 *
 * The defect these tests exist for: a node whose COMBO widgets are wired from another node
 * (an rgthree "KSampler Config" feeding sampler_name/scheduler) is stored two different ways
 * depending on the frontend that saved it. The "modern" form leaves no entry for a wired widget
 * in `widgets_values`; the "legacy full" form keeps the stale value it had before wiring. The
 * conversion loop in comfyui-workflow.js assumes the modern form, so a legacy-full node drifts
 * by one value per wired widget and every widget after the pair lands one slot early — e.g.
 * `denoise` receiving the string "dpmpp_2m_sde_gpu", which ComfyUI then rejects as a FLOAT.
 *
 * Upstream already solves this for subgraph-template nodes (_stripLegacyLinkedWidgetValues);
 * these tests cover the parent-graph case, which had no such normalisation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const REPO = new URL("../../", import.meta.url).pathname;

/**
 * `FLS_SamplerV4`-shaped sampler: widget order seed/control, steps, cfg, sampler_name,
 * scheduler, denoise, then one extra float — the same span the real node has.
 */
const OBJECT_INFO = {
    "SamplerLikeFLS": {
        input: {
            required: {
                model: ["MODEL"],
                seed: ["INT", { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
                steps: ["INT", { default: 20, min: 1, max: 10000 }],
                cfg: ["FLOAT", { default: 8, min: 0, max: 100 }],
                sampler_name: [["euler", "euler_ancestral", "dpmpp_2m_sde_gpu"]],
                scheduler: [["normal", "beta57", "simple"]],
                positive: ["CONDITIONING"],
                negative: ["CONDITIONING"],
                latent_image: ["LATENT"],
                denoise: ["FLOAT", { default: 1, min: 0, max: 1 }],
                fovea_strength: ["FLOAT", { default: 3, min: 0, max: 10 }],
            },
        },
        output: ["LATENT"],
    },
    "KSamplerConfigLike": {
        input: {
            required: {
                steps: ["INT", { default: 30, min: 1, max: 10000 }],
                cfg: ["FLOAT", { default: 8, min: 0, max: 100 }],
                sampler_name: [["euler", "euler_ancestral", "dpmpp_2m_sde_gpu"]],
                scheduler: [["normal", "beta57", "simple"]],
            },
        },
        output: ["INT", "FLOAT", "COMBO", "COMBO"],
    },
    "PlainSamplerLike": {
        input: {
            required: {
                model: ["MODEL"],
                seed: ["INT", { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
                steps: ["INT", { default: 20, min: 1, max: 10000 }],
                cfg: ["FLOAT", { default: 8, min: 0, max: 100 }],
                sampler_name: [["euler", "euler_ancestral", "dpmpp_2m_sde_gpu"]],
                scheduler: [["normal", "beta57", "simple"]],
                positive: ["CONDITIONING"],
                negative: ["CONDITIONING"],
                latent_image: ["LATENT"],
                denoise: ["FLOAT", { default: 1, min: 0, max: 1 }],
                fovea_strength: ["FLOAT", { default: 3, min: 0, max: 10 }],
            },
        },
        output: ["LATENT"],
    },
};

globalThis.fetch = async () => ({ ok: true, json: async () => OBJECT_INFO });

const { comfyWorkflow } = await import(`${REPO}static/js/core/workflow.js`);

/** The six input slots of the sampler node, in the order the UI stores them. */
function samplerSlots(samplerNameLink, schedulerLink) {
    return [
        { name: "model", type: "MODEL", link: 5 },
        { name: "positive", type: "CONDITIONING", link: 6 },
        { name: "negative", type: "CONDITIONING", link: 7 },
        { name: "latent_image", type: "LATENT", link: 8 },
        { name: "sampler_name", type: "COMBO", link: samplerNameLink },
        { name: "scheduler", type: "COMBO", link: schedulerLink },
    ];
}

function workflow(widgetsValues, withConfigLinks) {
    const links = [
        [5, 3, 0, 1, 0, "MODEL"],
        [6, 4, 0, 1, 1, "CONDITIONING"],
        [7, 4, 0, 1, 2, "CONDITIONING"],
        [8, 3, 1, 1, 3, "LATENT"],
    ];
    const nodes = [
        {
            id: 1, type: "SamplerLikeFLS", mode: 0,
            inputs: samplerSlots(withConfigLinks ? 9 : null, withConfigLinks ? 10 : null),
            outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
            widgets_values: widgetsValues,
        },
        {
            id: 3, type: "EmptyLatentLike", mode: 0, inputs: [], outputs: [], widgets_values: [],
        },
        {
            id: 4, type: "CLIPTextEncodeLike", mode: 0, inputs: [], outputs: [], widgets_values: [],
        },
    ];
    if (withConfigLinks) {
        links.push([9, 2, 2, 1, 4, "COMBO"], [10, 2, 3, 1, 5, "COMBO"]);
        nodes.push({
            id: 2, type: "KSamplerConfigLike", mode: 0, inputs: [],
            outputs: [
                { name: "steps", type: "INT", links: [] },
                { name: "cfg", type: "FLOAT", links: [] },
                { name: "sampler_name", type: "COMBO", links: [9] },
                { name: "scheduler", type: "COMBO", links: [10] },
            ],
            widgets_values: [30, 8, "euler_ancestral", "beta57"],
        });
    }
    return { nodes, links };
}

/** The real shape from animanga-liino-clean.json node 724: wired widgets keep their old values. */
const LEGACY_FULL = [706020072129535, "randomize", 12, 1.6, "dpmpp_2m_sde_gpu", "simple", 1, 3];
/** The same node saved by a frontend that drops the wired entries instead. */
const MODERN = [706020072129535, "randomize", 12, 1.6, 1, 3];

const EXPECTED = {
    seed: 706020072129535,
    steps: 12,
    cfg: 1.6,
    denoise: 1,
    fovea_strength: 3,
};

test("convertUiToApi: a legacy-full sampler keeps its own denoise, not the wired combo's stale value", async () => {
    const out = await comfyWorkflow.convertUiToApi(workflow(LEGACY_FULL, true));
    const inputs = out["1"].inputs;

    // The two wired widgets must be links, not values.
    assert.deepEqual(inputs.sampler_name, ["2", 2]);
    assert.deepEqual(inputs.scheduler, ["2", 3]);
    // And the widgets after them must read their own slots. Without the normalisation this is
    // where the drift shows: denoise "dpmpp_2m_sde_gpu", fovea_strength "simple", and the last
    // two values falling off the end entirely.
    assert.equal(inputs.denoise, EXPECTED.denoise, "denoise must stay the number 1");
    assert.equal(inputs.fovea_strength, EXPECTED.fovea_strength);
    assert.equal(inputs.steps, EXPECTED.steps);
    assert.equal(inputs.cfg, EXPECTED.cfg);
    assert.equal(inputs.seed, EXPECTED.seed);
    for (const key of ["denoise", "fovea_strength", "steps", "cfg"]) {
        assert.equal(typeof inputs[key], "number", `${key} must not be a string`);
    }
});

test("convertUiToApi: the modern format is mapped exactly as before (no shift introduced)", async () => {
    const out = await comfyWorkflow.convertUiToApi(workflow(MODERN, true));
    const inputs = out["1"].inputs;
    assert.deepEqual(inputs.sampler_name, ["2", 2]);
    assert.equal(inputs.denoise, 1);
    assert.equal(inputs.fovea_strength, 3);
    assert.equal(inputs.steps, 12);
});

test("convertUiToApi: an unwired sampler is untouched by the normalisation", async () => {
    const out = await comfyWorkflow.convertUiToApi(workflow(LEGACY_FULL, false));
    const inputs = out["1"].inputs;
    assert.equal(inputs.sampler_name, "dpmpp_2m_sde_gpu", "still a widget value, no link exists");
    assert.equal(inputs.scheduler, "simple");
    assert.equal(inputs.denoise, 1);
    assert.equal(inputs.fovea_strength, 3);
});

test("convertUiToApi: partial wiring (only sampler_name fed in) shifts by one, and must not", async () => {
    // The common real-world shape: one combo converted to an input, the other still a widget.
    const links = [
        [5, 3, 0, 1, 0, "MODEL"],
        [6, 4, 0, 1, 1, "CONDITIONING"],
        [7, 4, 0, 1, 2, "CONDITIONING"],
        [8, 3, 1, 1, 3, "LATENT"],
        [9, 2, 2, 1, 4, "COMBO"],
    ];
    const wf = workflow(LEGACY_FULL, false);
    wf.nodes[0].inputs[4].link = 9;
    wf.links = links;
    wf.nodes.push({
        id: 2, type: "KSamplerConfigLike", mode: 0, inputs: [],
        outputs: [
            { name: "steps", type: "INT", links: [] },
            { name: "cfg", type: "FLOAT", links: [] },
            { name: "sampler_name", type: "COMBO", links: [9] },
            { name: "scheduler", type: "COMBO", links: [] },
        ],
        widgets_values: [30, 8, "euler_ancestral", "beta57"],
    });
    const out = await comfyWorkflow.convertUiToApi(wf);
    const inputs = out["1"].inputs;
    assert.deepEqual(inputs.sampler_name, ["2", 2]);
    assert.equal(inputs.scheduler, "simple", "the unwired combo keeps its own stored value");
    assert.equal(inputs.denoise, 1);
    assert.equal(inputs.fovea_strength, 3);
});

test("convertUiToApi: the normalisation strips the wired slots and nothing else", async () => {
    const inputs = (await comfyWorkflow.convertUiToApi(workflow(LEGACY_FULL, true)))["1"].inputs;
    const widgetKeys = ["seed", "steps", "cfg", "denoise", "fovea_strength"];
    for (const key of widgetKeys) {
        assert.ok(key in inputs, `${key} must still be present (nothing dropped)`);
    }
    // Every value in the node's own widget span must be one of its own stored values.
    const own = new Set(LEGACY_FULL);
    for (const key of widgetKeys) assert.ok(own.has(inputs[key]), `${key}=${inputs[key]} came from another slot`);
});
