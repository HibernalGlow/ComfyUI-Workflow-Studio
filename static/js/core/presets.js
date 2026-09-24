/**
 * core/presets.js — build a generation-preset record from a form.
 *
 * The payload shape is *not* invented here: it is what
 * `py/services/gen_presets_service.py::apply_preset_to_workflow` reads back
 * (`sampling_mode`, then either `sampler_settings` or the `sampler_stage1` / `sampler_stage2`
 * pair, plus `loras`, `quality_prefix`, `default_negative`), and the defaults match the
 * service's own `settings.get(key, fallback)` values. A unit test asserts the correspondence,
 * so a future edit that renames a key fails here rather than writing a record the applier
 * silently ignores.
 *
 * One deliberate deviation from the old UI: `static/js/gen-presets.js` sends
 * `sampler_settings` even when the user picked two-stage mode, so the applier takes the
 * `double` branch, finds no stage keys, and stamps its hardcoded fallbacks (5 / 4.6 / er_sde /
 * simple) instead of what was typed. A double preset is now written in the shape the reader
 * actually looks for.
 *
 * Requires nothing outside this module: no DOM, no network, no caller state.
 */

/** Upstream's fixed quality scaffolding, kept verbatim so old and new presets stay comparable. */
export const PRESET_QUALITY_PREFIX = "masterpiece, best quality, aesthetic, highly detailed";
export const PRESET_DEFAULT_NEGATIVE =
    "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits";

function stageOf(prefix, form, fallbacks) {
    // `Number("")` is 0, so an empty field has to be treated as absent before coercion.
    const numOf = (key, fallback) => {
        const raw = form[`${prefix}${key}`];
        if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
        const n = Number(raw);
        return Number.isFinite(n) ? n : fallback;
    };
    const textOf = (key, fallback) => {
        const raw = String(form[`${prefix}${key}`] || "").trim();
        return raw || fallback;
    };
    return {
        steps: numOf("steps", fallbacks.steps),
        cfg: numOf("cfg", fallbacks.cfg),
        sampler_name: textOf("sampler_name", fallbacks.sampler_name),
        scheduler: textOf("scheduler", fallbacks.scheduler),
        denoise: numOf("denoise", 1.0),
    };
}

/**
 * @param {{
 *   name: string, description?: string, sampling_mode?: 'single'|'double',
 *   steps?: number|string, cfg?: number|string,
 *   sampler_name?: string, scheduler?: string, denoise?: number|string,
 *   stage1steps?: number|string, stage1cfg?: number|string,
 *   stage1sampler_name?: string, stage1scheduler?: string,
 *   stage2steps?: number|string, stage2cfg?: number|string,
 *   stage2sampler_name?: string, stage2scheduler?: string,
 * }} form flat on purpose: it is the dialog's state object, unmodified
 * @param {{now?:number, loras?:Array|null, workflow?:string|null}} [options]
 * @returns {object} a preset record ready for `POST /api/wfm/gen_presets`
 */
export function buildSamplerPreset(form = {}, { now = Date.now(), loras = null, workflow = null } = {}) {
    const mode = form.sampling_mode === "double" ? "double" : "single";
    const preset = {
        id: `custom-${now}`,
        name: String(form.name || "").trim(),
        description: String(form.description || "").trim(),
        sampling_mode: mode,
        loras: Array.isArray(loras) ? loras : [],
        quality_prefix: PRESET_QUALITY_PREFIX,
        default_negative: PRESET_DEFAULT_NEGATIVE,
    };
    if (workflow) preset.workflow = String(workflow);

    if (mode === "single") {
        preset.sampler_settings = stageOf("", form, {
            steps: 12, cfg: 1.6, sampler_name: "euler_ancestral", scheduler: "beta57",
        });
    } else {
        // Two independent stages; a blank stage 2 falls back to the fine-sampling defaults
        // the service itself uses rather than to stage 1's coarse values.
        preset.sampler_stage1 = stageOf("stage1", form, {
            steps: 5, cfg: 4.6, sampler_name: "er_sde", scheduler: "simple",
        });
        preset.sampler_stage2 = stageOf("stage2", form, {
            steps: 12, cfg: 1.6, sampler_name: "dpmpp_2m_sde_gpu", scheduler: "beta57",
        });
    }
    return preset;
}

/** Which stage fields a mode shows — the view and the builder must never disagree. */
export function presetStageKeys(mode) {
    return mode === "double"
        ? ["stage1steps", "stage1cfg", "stage1sampler_name", "stage1scheduler",
            "stage2steps", "stage2cfg", "stage2sampler_name", "stage2scheduler"]
        : ["steps", "cfg", "sampler_name", "scheduler", "denoise"];
}
