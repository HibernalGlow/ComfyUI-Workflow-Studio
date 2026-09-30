/**
 * Decision model client (Unsloth Decision API / Laya).
 *
 * Laya is a *decision* model, not a generator: it takes a state (text or any JSON) plus typed
 * questions and returns calibrated probabilities in one forward pass — no free-form output, so no
 * format hallucination, and results can be thresholded directly. Text only (no image input):
 * image-based judgments must first be turned into text (Tagger tags / VLM caption).
 *
 * Unsloth requires an API key even on localhost, so requests go through the same server-side
 * proxy as the Unsloth chat backend (py/routes/unsloth_routes.py, key from .env — the same Unsloth
 * Desktop key the chat backend uses). Backend/URL/model/threshold come from the Settings tab's own
 * "Decision Model" section (wfm_decision_settings), independent of the AI TOOL / Tagger backends so
 * a decision model can run alongside whichever LLM/VLM those use.
 * API reference: https://unsloth.ai/docs/models/decision-laya
 *
 * Usage (threshold defaults to the Settings tab value when omitted):
 *   import { decide, noul, choice, score, isYes, pickChoice } from "./decision-client.js";
 *   const answers = await decide(promptText, {
 *       genre: choice("Which genre fits best?", { portrait: "a person is the main subject", landscape: "scenery" }),
 *       text:  noul("Does the image contain rendered text?"),
 *       nsfw:  score("How sexually explicit is this?", ["none", "suggestive", "explicit"]),
 *   });
 *   const genre = pickChoice(answers.genre, 0.8);   // { value, probability, confident }
 */

import { unslothProxy, readJsonStorage } from "./util.js";

// Limits documented by Unsloth's Decision API.
export const DECISION_LIMITS = { maxQuestions: 64, maxChoiceOptions: 255, maxScoreLevels: 10 };

// "laya" = the model picked in Unsloth's settings. Explicit variants: "laya-multilingual" (default
// download, 100+ languages), "laya-english", "laya-typed-decisions" (structured data such as JSON
// records — e.g. workflow node summaries).
export const DECISION_MODELS = ["laya", "laya-multilingual", "laya-english", "laya-typed-decisions"];
export const DEFAULT_DECISION_MODEL = "laya";

// Only Unsloth for now; kept as a field so another TypeSafe-compatible server (e.g. ollaya on
// :11435, which needs no key) can be added later without changing the stored settings shape.
export const DECISION_BACKENDS = { unsloth: { defaultUrl: "http://localhost:8888" } };

export const DECISION_SETTINGS_KEY = "wfm_decision_settings";
const DEFAULT_SETTINGS = {
    backend: "unsloth",
    baseUrl: DECISION_BACKENDS.unsloth.defaultUrl,
    model: DEFAULT_DECISION_MODEL,
    threshold: 0.8,
};

/** Saved Decision Model settings merged over the defaults. */
export function getDecisionSettings() {
    const saved = readJsonStorage(DECISION_SETTINGS_KEY);
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    const th = Number(merged.threshold);
    merged.threshold = th > 0 && th <= 1 ? th : DEFAULT_SETTINGS.threshold;
    if (!DECISION_BACKENDS[merged.backend]) merged.backend = DEFAULT_SETTINGS.backend;
    if (!merged.baseUrl) merged.baseUrl = DECISION_BACKENDS[merged.backend].defaultUrl;
    if (!merged.model) merged.model = DEFAULT_DECISION_MODEL;
    return merged;
}

export function saveDecisionSettings(patch) {
    const data = { ...getDecisionSettings(), ...patch };
    localStorage.setItem(DECISION_SETTINGS_KEY, JSON.stringify(data));
    return data;
}

// ---- Question builders ----

/** Yes/no question — answer.noul is the probability of "yes" (0..1). */
export function noul(instructions) {
    return { type: "noul", instructions };
}

/**
 * Pick-one question. criteria: an array of option names, or { option: description } — descriptions
 * noticeably improve accuracy (options share a token budget, so past ~20 described options the
 * descriptions get trimmed).
 */
export function choice(instructions, criteria) {
    return { type: "choice", instructions, criteria };
}

/** Rating question. levels: ordered labels from lowest (0) to highest, 2..10 entries. */
export function score(instructions, levels) {
    return { type: "score", instructions, criteria: levels };
}

// ---- Request ----


function _validateQuestions(questions) {
    const entries = Object.entries(questions || {});
    if (entries.length === 0) throw new Error("decide(): no questions given");
    if (entries.length > DECISION_LIMITS.maxQuestions) {
        throw new Error(`decide(): ${entries.length} questions exceeds the limit of ${DECISION_LIMITS.maxQuestions}`);
    }
    for (const [key, q] of entries) {
        if (!q || !["noul", "choice", "score"].includes(q.type)) {
            throw new Error(`decide(): question "${key}" has an unknown type`);
        }
        const n = Array.isArray(q.criteria) ? q.criteria.length : Object.keys(q.criteria || {}).length;
        if (q.type === "choice" && (n < 2 || n > DECISION_LIMITS.maxChoiceOptions)) {
            throw new Error(`decide(): choice "${key}" needs 2-${DECISION_LIMITS.maxChoiceOptions} options (got ${n})`);
        }
        if (q.type === "score" && (n < 2 || n > DECISION_LIMITS.maxScoreLevels)) {
            throw new Error(`decide(): score "${key}" needs 2-${DECISION_LIMITS.maxScoreLevels} levels (got ${n})`);
        }
    }
}

/**
 * Ask typed questions about one state. Returns the raw `answers` object keyed like `questions`.
 * The first call after Unsloth starts loads the model (10-20 s); later calls are sub-second on CPU.
 *
 * @param {string|object} state  Text or any JSON (e.g. { prompt, tags, model }).
 * @param {object} questions     { key: noul(...) | choice(...) | score(...) }, max 64.
 * @param {object} [opts]        { model, baseUrl } — override the saved Decision Model settings.
 */
export async function decide(state, questions, opts = {}) {
    _validateQuestions(questions);
    const settings = getDecisionSettings();
    const payload = { model: opts.model || settings.model, state, questions };
    const data = await unslothProxy(opts.baseUrl || settings.baseUrl, "/v1/systemone", "POST", payload);
    if (!data || typeof data.answers !== "object") throw new Error("Decision API returned no answers");
    return data.answers;
}

/**
 * Run decide() over many states with a small concurrency cap (the model runs locally, so flooding
 * it only queues requests). Per-item failures are returned as { error } instead of rejecting all.
 */
export async function decideMany(states, questions, opts = {}) {
    const concurrency = Math.max(1, opts.concurrency || 2);
    const results = new Array(states.length);
    let next = 0;
    const worker = async () => {
        while (next < states.length) {
            const i = next++;
            try {
                results[i] = { answers: await decide(states[i], questions, opts) };
            } catch (e) {
                results[i] = { error: e.message };
            }
            opts.onProgress?.(i, results[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, states.length) }, worker));
    return results;
}

/**
 * Connection check for the Settings tab: one yes/no question, timed. The first request after
 * Unsloth starts also loads the model (10-20 s), so callers should say that a slow first test is
 * normal.
 */
export async function testDecisionConnection(opts = {}) {
    const started = performance.now();
    const answers = await decide("A cat is sitting on a sofa.", {
        test: noul("Is there an animal in the text?"),
    }, opts);
    return { ms: Math.round(performance.now() - started), yes: answers.test?.noul };
}

// ---- Answer helpers ----
// Threshold on `probabilities` (or noul's value), not `confidence` — per Unsloth's docs, confidence
// only says how peaked the distribution is and its formula differs from Jev's.

/** True when the yes-probability of a noul answer reaches `threshold`. */
export function isYes(answer, threshold = getDecisionSettings().threshold) {
    return typeof answer?.noul === "number" && answer.noul >= threshold;
}

/**
 * Most likely option of a choice answer. `confident` is false below `threshold` — callers should
 * then show the value as a suggestion for the user to confirm rather than apply it automatically.
 */
export function pickChoice(answer, threshold = getDecisionSettings().threshold) {
    const value = answer?.choice ?? null;
    const probability = value != null ? (answer.probabilities?.[value] ?? 0) : 0;
    return { value, probability, confident: value != null && probability >= threshold };
}

/**
 * Most likely level of a score answer: { level (index from 0), label, value (expected score,
 * fractional), probability, confident }.
 */
export function pickScore(answer, threshold = getDecisionSettings().threshold) {
    const probs = answer?.probabilities || {};
    let level = null, probability = 0;
    for (const [k, p] of Object.entries(probs)) {
        if (p > probability) { level = Number(k); probability = p; }
    }
    return {
        level,
        label: level != null ? (answer.legend?.[String(level)] ?? null) : null,
        value: typeof answer?.score === "number" ? answer.score : null,
        probability,
        confident: level != null && probability >= threshold,
    };
}
