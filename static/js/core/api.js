/**
 * core/api.js — THE network layer for the Workflow-Studio backend.
 *
 * Every `/api/wfm/*` and every `/wfm/gallery/*` call in the project goes through
 * this module. It is deliberately:
 *   - DOM-free (no element lookups, no event wiring, nothing stored in the page)
 *   - UI-concept-free (no toast / dialog / redirect; errors are thrown as Error,
 *     progress is delivered through callbacks)
 *   - dependency-free (no third-party imports; nothing imported at all)
 *
 * ComfyUI-core endpoints (`/object_info`, `/prompt`, `/history/{}`, `/view`,
 * `/upload/image`, `/system_stats`, `/ws`) are NOT re-implemented here — they are
 * owned by `core/client.js` (upstream `comfyui-client.js`).
 *
 * Prefix rule (verified against `py/routes/*.py`):
 *   - every module except one uses  /api/wfm/...
 *   - `gallery_routes.py` uses     /wfm/gallery/...   (NO `/api`)  — see GALLERY
 *   - `tagger_routes.py` uses      /wfm/tagger/...    (NO `/api`)  — not implemented
 *
 * Binary responses (images, zips, PSDs, JSON downloads) never flow through the
 * JSON helper: `<img src>` / `<a href>` consumers get pure URL strings from the
 * `*Url()` builders; POST-only binary endpoints return a Blob instead.
 *
 * Deliberately NOT implemented (tabs the new UI does not include):
 *   nodes (9), tagger (17), lab (5), video (12), image-edit/gmic (3),
 *   ai/unsloth (1), ai/skill (4)  → 51 of the 151 documented endpoints.
 * The remaining 100 are covered below.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal transport (private)
// ─────────────────────────────────────────────────────────────────────────────

/** URL-encode a path segment (model names, workflow names, gallery groups…). */
function seg(value) {
    return encodeURIComponent(String(value));
}

/** Append query params to an absolute path, skipping null/undefined values. */
function buildUrl(path, query) {
    if (!query) return path;
    const parts = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item === undefined || item === null) continue;
                parts.push(`${seg(key)}=${seg(item)}`);
            }
        } else {
            parts.push(`${seg(key)}=${seg(value)}`);
        }
    }
    if (parts.length === 0) return path;
    return path + (path.includes("?") ? "&" : "?") + parts.join("&");
}

/** Build an Error from a non-OK response body, preferring `{error}` / `{message}`. */
function errorFromBody(res, text, data) {
    let message = "";
    if (data && typeof data === "object") {
        message = data.error || data.message || "";
    }
    if (!message) message = String(text || "").trim();
    if (!message) message = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data === undefined ? null : data;
    return err;
}

/** Read a non-OK response once and convert it into a thrown Error. */
async function toError(res) {
    let text = "";
    try {
        text = await res.text();
    } catch {
        text = "";
    }
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null; // plain-text error (e.g. `type and name are required`)
    }
    return errorFromBody(res, text, data);
}

function abortError() {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    return err;
}

/**
 * The single JSON/multipart request helper.
 *
 * @param {string} path   absolute path, e.g. "/api/wfm/models/groups"
 * @param {object} [opts]
 * @param {string} [opts.method="GET"]
 * @param {object} [opts.query]           appended, null/undefined skipped
 * @param {any}    [opts.body]            plain object/array → JSON; FormData → multipart
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.headers]
 * @returns {Promise<any>} parsed JSON (or the raw text when a 200 body is not JSON);
 *                         `null` for an empty body / 204.
 * @throws {Error} with `.status` (HTTP code, 0 for a transport failure) and `.data`.
 */
async function request(path, opts = {}) {
    const { method = "GET", query, body, signal, headers } = opts;
    const init = { method, headers: { Accept: "application/json", ...(headers || {}) } };
    if (signal) init.signal = signal;

    if (body instanceof FormData) {
        init.body = body; // let the browser set the multipart boundary
    } else if (body !== undefined && body !== null) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }

    let res;
    try {
        res = await fetch(buildUrl(path, query), init);
    } catch (e) {
        if (e && e.name === "AbortError") throw e;
        const err = new Error(e && e.message ? e.message : "Network request failed");
        err.status = 0;
        err.cause = e;
        throw err;
    }

    if (!res.ok) throw await toError(res);
    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text; // non-JSON 200 (should not happen for /api/wfm/*; kept harmless)
    }
}

/**
 * POST/PUT a JSON body and return a Blob — used by the few binary endpoints that
 * cannot be expressed as a URL (`<a href>` cannot issue a POST).
 */
async function requestBlob(path, opts = {}) {
    const { method = "POST", query, body, signal, headers } = opts;
    const init = { method, headers: { Accept: "*/*", ...(headers || {}) } };
    if (signal) init.signal = signal;
    if (body !== undefined && body !== null) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(buildUrl(path, query), init);
    } catch (e) {
        if (e && e.name === "AbortError") throw e;
        const err = new Error(e && e.message ? e.message : "Network request failed");
        err.status = 0;
        err.cause = e;
        throw err;
    }
    if (!res.ok) throw await toError(res);
    return res.blob();
}

/** Split one SSE frame (no trailing blank line) and hand the payload to `onEvent`. */
function dispatchSseFrame(frame, onEvent) {
    if (!frame) return;
    let event = "message";
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue; // comment / heartbeat
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        payload = raw;
    }
    onEvent(event, payload, raw);
}

/**
 * Read a `text/event-stream` response frame by frame.
 * Honours `signal` and always cancels the reader (never leaks the stream).
 *
 * @param {string} path
 * @param {any} body                     JSON body (omitted when undefined/null)
 * @param {(event: string, payload: any, raw: string) => void} onEvent
 * @param {AbortSignal} [signal]
 */
async function requestSSE(path, body, onEvent, signal) {
    if (signal && signal.aborted) throw abortError();

    const init = { method: "POST", headers: { Accept: "text/event-stream" } };
    if (body !== undefined && body !== null) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    if (signal) init.signal = signal;

    const res = await fetch(path, init);
    if (!res.ok) throw await toError(res);
    if (!res.body) throw new Error("Streaming not supported by this response");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const frameSeparator = /\r?\n\r?\n/;
    let buffer = "";
    let streamDone = false;

    const cancelReader = () => {
        if (streamDone) return;
        streamDone = true;
        try {
            Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
            /* stream already closed */
        }
    };
    if (signal) signal.addEventListener("abort", cancelReader, { once: true });

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let match;
            while ((match = frameSeparator.exec(buffer)) !== null) {
                const frame = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                dispatchSseFrame(frame, onEvent);
            }
        }
        streamDone = true;
        buffer += decoder.decode();
        if (buffer.trim()) dispatchSseFrame(buffer, onEvent);
    } finally {
        if (signal) signal.removeEventListener("abort", cancelReader);
        cancelReader(); // no-op once the stream ended normally
    }
    if (signal && signal.aborted) throw abortError();
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings (py/routes/settings_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/wfm/settings → the full server settings dict. */
export function getSettingsFromServer() {
    return request("/api/wfm/settings");
}

/** POST /api/wfm/settings → `{status, settings}`. `patch` is merged server-side. */
export function saveSettingsToServer(patch) {
    return request("/api/wfm/settings", { method: "POST", body: patch });
}

/** GET /api/wfm/settings/workflows-dir → `{current, default}`. */
export function getWorkflowsDir() {
    return request("/api/wfm/settings/workflows-dir");
}

/** POST /api/wfm/settings/workflows-dir → `{status, workflows_dir}`. `""` resets. */
export function setWorkflowsDir(dir) {
    return request("/api/wfm/settings/workflows-dir", {
        method: "POST",
        body: { workflows_dir: dir },
    });
}

/** GET /api/wfm/settings/output-dir → `{current, default, saved}`. */
export function getOutputDir() {
    return request("/api/wfm/settings/output-dir");
}

/**
 * POST /api/wfm/settings/output-dir → `{status, current, default, saved}`.
 * Side effect: also sets the gallery root server-side (required before
 * `saveImageToGallery`). `""` resets to the ComfyUI output directory.
 */
export function setOutputDir(dir) {
    return request("/api/wfm/settings/output-dir", {
        method: "POST",
        body: { gallery_output_dir: dir },
    });
}

/** URL (GET download) for `/api/wfm/settings/export` — `wfm-data-export.json`. */
export function settingsExportUrl() {
    return "/api/wfm/settings/export";
}

/** POST /api/wfm/settings/import → `{status, imported, skipped}`. Body = whole bundle. */
export function importSettingsBundle(bundle) {
    return request("/api/wfm/settings/import", { method: "POST", body: bundle });
}

/**
 * URL (GET download) for `/api/wfm/settings/export-full` — `wfm-full-backup.zip`.
 * @param {{includeWorkflows?: boolean, includeWildcard?: boolean}} [opts]
 */
export function settingsExportFullUrl(opts = {}) {
    const query = {};
    if (opts.includeWorkflows) query.include_workflows = "1";
    if (opts.includeWildcard) query.include_wildcard = "1";
    return buildUrl("/api/wfm/settings/export-full", query);
}

/** POST /api/wfm/settings/import-full (multipart field `file`) → `{status, extracted, skipped}`. */
export function importFullBackup(file) {
    const fd = new FormData();
    fd.append("file", file);
    return request("/api/wfm/settings/import-full", { method: "POST", body: fd });
}

// ── Styles ───────────────────────────────────────────────────────────────────

/** GET /api/wfm/styles → `[{name, prompt, negative_prompt, file}]`. */
export function listStyles() {
    return request("/api/wfm/styles");
}

/** POST /api/wfm/styles → `{ok:true}`; 400 on duplicate name / unknown file. */
export function createStyle(style) {
    return request("/api/wfm/styles", { method: "POST", body: style });
}

/** PUT /api/wfm/styles/{name} → `{ok:true}`. Body `{name, prompt, negative_prompt}`. */
export function updateStyle(originalName, style) {
    return request(`/api/wfm/styles/${seg(originalName)}`, { method: "PUT", body: style });
}

/** DELETE /api/wfm/styles/{name} → `{ok:true}`. */
export function deleteStyle(name) {
    return request(`/api/wfm/styles/${seg(name)}`, { method: "DELETE" });
}

// ── Generation / sampler presets (py/routes/gen_presets_routes.py) ────────────

/** GET /api/wfm/gen_presets → array of preset objects. */
export function listGenPresets() {
    return request("/api/wfm/gen_presets");
}

/** POST /api/wfm/gen_presets → `{status, preset}`. `preset` is forwarded verbatim. */
export function saveGenPreset(preset) {
    return request("/api/wfm/gen_presets", { method: "POST", body: preset });
}

/**
 * POST /api/wfm/gen_presets/apply → `{status, preset, workflow}`.
 * @param {{workflow: object, preset?: object, preset_id?: string}} payload
 *        exactly one of `preset` / `preset_id` must be present.
 */
export function applyGenPreset(payload) {
    return request("/api/wfm/gen_presets/apply", { method: "POST", body: payload });
}

/** DELETE /api/wfm/gen_presets/{id} → `{status, deleted}`. */
export function deleteGenPreset(id) {
    return request(`/api/wfm/gen_presets/${seg(id)}`, { method: "DELETE" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflows (py/routes/workflow_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/wfm/workflows → `[{filename, analysis, metadata, mtime, thumbnail}]`. */
export function listWorkflows() {
    return request("/api/wfm/workflows");
}

/** GET /api/wfm/workflows/raw?filename=… → the workflow JSON (UI or API format). */
export function loadWorkflow(name) {
    return request("/api/wfm/workflows/raw", { query: { filename: name } });
}

/**
 * Persist a workflow JSON under the workflows directory.
 *
 * CAVEAT: the backend exposes no "write workflow" endpoint. This is implemented
 * through `POST /api/wfm/workflows/import` (multipart `files` part), which for a
 * `.json` part writes the payload verbatim to `<workflows_dir>/<filename>`
 * (overwriting an existing file of the same name). Analysis is recomputed on the
 * next `listWorkflows()` call. `name` gets a `.json` suffix when missing.
 *
 * @returns {Promise<{status:"ok", filename:string, results:Array}>}
 * @throws {Error} when the server rejects the file (e.g. invalid filename).
 */
export async function saveWorkflow(name, workflow) {
    const filename = /\.json$/i.test(String(name)) ? String(name) : `${name}.json`;
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" });
    const fd = new FormData();
    fd.append("files", blob, filename);
    const data = await request("/api/wfm/workflows/import", { method: "POST", body: fd });
    const results = Array.isArray(data && data.results) ? data.results : [];
    const mine = results.find((r) => r && r.name === filename) || results[0];
    if (!mine || mine.status !== "success") {
        throw new Error((mine && mine.message) || "Workflow save failed");
    }
    return { status: "ok", filename, results };
}

/** POST /api/wfm/workflows/metadata → `{status:"ok"}`. `{filename, ...updates}`. */
export function saveWorkflowMetadata(filename, updates) {
    return request("/api/wfm/workflows/metadata", {
        method: "POST",
        body: { filename, ...(updates || {}) },
    });
}

/**
 * POST /api/wfm/workflows/import (multipart, repeated part name `files`)
 * → `{results:[{name,status,message?}]}`.
 * @param {File|Blob|Array<File|Blob>} files
 */
export function importWorkflows(files) {
    const list = Array.isArray(files) ? files : [files];
    const fd = new FormData();
    for (const file of list) fd.append("files", file);
    return request("/api/wfm/workflows/import", { method: "POST", body: fd });
}

/** POST /api/wfm/workflows/rename → service result; HTTP status comes from the service. */
export function renameWorkflow(filename, newStem) {
    return request("/api/wfm/workflows/rename", {
        method: "POST",
        body: { filename, newStem },
    });
}

/** POST /api/wfm/workflows/delete → `{status:"ok"}`. */
export function deleteWorkflow(filename) {
    return request("/api/wfm/workflows/delete", { method: "POST", body: { filename } });
}

/** POST /api/wfm/workflows/analyze → `{analysis}`. */
export function analyzeWorkflow(filename) {
    return request("/api/wfm/workflows/analyze", { method: "POST", body: { filename } });
}

/** POST /api/wfm/workflows/reanalyze-all → service result dict (no body). */
export function reanalyzeAllWorkflows() {
    return request("/api/wfm/workflows/reanalyze-all", { method: "POST" });
}

/** POST /api/wfm/workflows/change-thumbnail (multipart) → `{status, thumbnail}`. */
export function changeWorkflowThumbnail(filename, file) {
    const fd = new FormData();
    fd.append("filename", filename);
    fd.append("file", file);
    return request("/api/wfm/workflows/change-thumbnail", { method: "POST", body: fd });
}

/** POST /api/wfm/workflows/save-canvas-image (multipart) → `{status, filename}`. */
export function saveCanvasImage(filename, image) {
    const fd = new FormData();
    fd.append("filename", filename);
    fd.append("image", image);
    return request("/api/wfm/workflows/save-canvas-image", { method: "POST", body: fd });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wildcards (py/routes/wildcard_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/wfm/wildcards → `[{name, filename, ext, size, dir, wc_name}]`. */
export function getWildcards() {
    return request("/api/wfm/wildcards");
}

/**
 * GET /api/wfm/wildcards/content?filename=… → the file text, or `null` when the
 * file does not exist (404) / cannot be read.
 */
export async function getWildcardContent(filename) {
    try {
        const data = await request("/api/wfm/wildcards/content", { query: { filename } });
        return data && typeof data.content === "string" ? data.content : null;
    } catch (e) {
        if (e && e.status === 404) return null;
        throw e;
    }
}

/** POST /api/wfm/wildcards/save → `{status:"ok", file}`. */
export function saveWildcard(filename, content) {
    return request("/api/wfm/wildcards/save", { method: "POST", body: { filename, content } });
}

/** POST /api/wfm/wildcards/delete → `{status:"ok"}`. */
export function deleteWildcard(filename) {
    return request("/api/wfm/wildcards/delete", { method: "POST", body: { filename } });
}

/** GET /api/wfm/wildcards/link-status → Impact Pack link status object. */
export function getWildcardLinkStatus() {
    return request("/api/wfm/wildcards/link-status");
}

/** POST /api/wfm/wildcards/create-link → `{status:"ok", ...}`, reads `migrated_files`. */
export function createWildcardLink() {
    return request("/api/wfm/wildcards/create-link", { method: "POST" });
}

/** POST /api/wfm/wildcards/remove-link → `{status:"ok"}`. */
export function removeWildcardLink() {
    return request("/api/wfm/wildcards/remove-link", { method: "POST" });
}

/**
 * Expand A1111-style `__name__` references in a prompt string.
 *
 * The backend has NO server-side expansion endpoint (only `…/wildcards/content`),
 * so this is a client-side expansion built on that endpoint — same semantics as
 * upstream `generate-tab.js::_expandWildcardText`:
 *   - `__name__` resolves to a random non-empty, non-`#` line of `<name>.txt`
 *   - unknown names are left untouched
 *   - at most `maxPasses` rounds (nested wildcards)
 *
 * @param {string} text
 * @param {{ext?:string, maxPasses?:number, random?:()=>number, signal?:AbortSignal}} [opts]
 * @returns {Promise<string>} the expanded text (input returned as-is when it has no `__`)
 */
export async function expandWildcards(text, opts = {}) {
    const { ext = ".txt", maxPasses = 5, random = Math.random, signal } = opts;
    if (typeof text !== "string" || !text.includes("__")) return text;

    const cache = new Map();
    const linesFor = async (name) => {
        if (cache.has(name)) return cache.get(name);
        const filename = /\.[a-z0-9]+$/i.test(name) ? name : name + ext;
        let lines = null;
        try {
            const data = await request("/api/wfm/wildcards/content", {
                query: { filename },
                signal,
            });
            const raw = data && typeof data.content === "string" ? data.content : "";
            const parsed = raw
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith("#"));
            lines = parsed.length > 0 ? parsed : null;
        } catch (e) {
            if (e && e.name === "AbortError") throw e;
            lines = null; // missing / unreadable wildcard → keep the reference
        }
        cache.set(name, lines);
        return lines;
    };

    let current = text;
    for (let pass = 0; pass < maxPasses; pass++) {
        const matches = [...current.matchAll(/__([^_\s][^_]*)__/g)];
        if (matches.length === 0) break;
        let changed = false;
        let offset = 0;
        let result = current;
        for (const match of matches) {
            const lines = await linesFor(match[1]);
            if (!lines) continue;
            const replacement = lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))];
            const pos = match.index + offset;
            result = result.slice(0, pos) + replacement + result.slice(pos + match[0].length);
            offset += replacement.length - match[0].length;
            changed = true;
        }
        if (!changed) break;
        current = result;
    }
    return current;
}

// ─────────────────────────────────────────────────────────────────────────────
// LoRA trigger rules (py/routes/lora_trigger_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/wfm/lora/rules → array of rule objects. */
export function getLoraRules() {
    return request("/api/wfm/lora/rules");
}

/** POST /api/wfm/lora/rules — body is the raw array; echoes the saved array back. */
export function saveLoraRules(rules) {
    return request("/api/wfm/lora/rules", { method: "POST", body: rules });
}

/** POST /api/wfm/lora/rules/rescan → `{message, count, triggers}`. */
export function rescanLoraRules() {
    return request("/api/wfm/lora/rules/rescan", { method: "POST" });
}

/**
 * POST /api/wfm/lora/match → `{matched_loras, parsed_prompt}`.
 * Note: the service prepends a hard-coded Turbo entry whenever `autoTurbo` is
 * true (the server default), so callers that do not want it must pass `false`.
 *
 * @param {string} prompt
 * @param {{autoTurbo?:boolean, qualityPrefix?:string, signal?:AbortSignal}} [opts]
 */
export function matchLoras(prompt, opts = {}) {
    const body = { text: prompt };
    if (opts.autoTurbo !== undefined) body.auto_turbo = opts.autoTurbo;
    if (opts.qualityPrefix !== undefined) body.quality_prefix = opts.qualityPrefix;
    return request("/api/wfm/lora/match", { method: "POST", body, signal: opts.signal });
}

/**
 * POST /api/wfm/lora/apply → `{success, applied_count, workflow}`.
 * Caveat: `applied_count` is the length of the list sent, before the service
 * drops entries whose `active` is not `true`.
 *
 * @param {object} workflow
 * @param {Array|{loras?:Array, activeLoras?:Array, signal?:AbortSignal}} [opts]
 */
export function applyLoras(workflow, opts = {}) {
    const source = Array.isArray(opts) ? { loras: opts } : opts;
    return request("/api/wfm/lora/apply", {
        method: "POST",
        body: { workflow, loras: source.loras || source.activeLoras || [] },
        signal: source.signal,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt presets (py/routes/prompts_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/wfm/prompts → array of prompt objects (each has `id`). */
export function listPrompts() {
    return request("/api/wfm/prompts");
}

/** POST /api/wfm/prompts → `{status, prompt}`. Body forwarded verbatim. */
export function createPrompt(prompt) {
    return request("/api/wfm/prompts", { method: "POST", body: prompt });
}

/** POST /api/wfm/prompts/update → `{status, prompt}`. Body `{id, ...updates}`. */
export function updatePrompt(id, updates) {
    return request("/api/wfm/prompts/update", {
        method: "POST",
        body: { id, ...(updates || {}) },
    });
}

/** POST /api/wfm/prompts/delete → `{status:"ok"}`. */
export function deletePrompt(id) {
    return request("/api/wfm/prompts/delete", { method: "POST", body: { id } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Models (py/routes/models_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/wfm/models/metadata → `{ "<modelName>": {tags, favorite, memo, …} }`. */
export function getModelMetadata() {
    return request("/api/wfm/models/metadata");
}

/** POST /api/wfm/models/metadata → `{status, metadata}`; 400 without `modelName`. */
export function saveModelMetadata(modelName, updates) {
    return request("/api/wfm/models/metadata", {
        method: "POST",
        body: { modelName, ...(updates || {}) },
    });
}

/**
 * GET /api/wfm/models/groups?type=… → `{ "<groupName>": ["a.safetensors", …] }`.
 * Omit `type` to receive the groups of every model type at once.
 */
export function getModelGroups(type) {
    return request("/api/wfm/models/groups", { query: { type } });
}

/** POST /api/wfm/models/groups → `{status:"ok", groups}`; 400 without `model_type`. */
export function saveModelGroups(modelType, groups) {
    return request("/api/wfm/models/groups", {
        method: "POST",
        body: { model_type: modelType, groups },
    });
}

/**
 * URL (binary image, `Cache-Control: no-cache`) for `GET /api/wfm/models/preview`.
 * Use it on an `<img>` and detect "no preview" via the error event; the endpoint
 * answers 404 with an empty body, so a HEAD probe is not usable.
 * Server errors are plain text, not JSON.
 */
export function modelPreviewUrl(type, name) {
    return buildUrl("/api/wfm/models/preview", { type, name });
}

/** POST /api/wfm/models/civitai/fetch → `{status:"ok", sha256, civitai, preview_saved}`
 *  or `{status:"not_found", sha256, message}`. */
export function fetchCivitai(type, name) {
    return request("/api/wfm/models/civitai/fetch", { method: "POST", body: { type, name } });
}

/** GET /api/wfm/models/civitai/cache → CivitAI cache map, keyed by sha256 or name. */
export function getCivitaiCache() {
    return request("/api/wfm/models/civitai/cache");
}

/**
 * POST /api/wfm/models/civitai/batch — Server-Sent Events.
 * Events: `progress` `{current,total,model,status}` (status one of
 * hashing/fetching/cached/found/not_found) and a final `done`
 * `{total,found,not_found,errors,hashes,preview_saved}`.
 *
 * @param {string} type
 * @param {string[]} models
 * @param {(progress:{current:number,total:number,model:string,status:string})=>void} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} the `done` payload (null if the stream ended without one)
 */
export async function batchCivitai(type, models, onProgress, signal) {
    let done = null;
    await requestSSE(
        "/api/wfm/models/civitai/batch",
        { type, models },
        (event, payload) => {
            if (event === "progress") {
                if (typeof onProgress === "function") onProgress(payload);
            } else if (event === "done") {
                done = payload;
            }
        },
        signal
    );
    return done;
}

/**
 * POST /api/wfm/models/change-preview (multipart fields `type`, `name`, `file`)
 * → `{status:"ok"}`.
 * @param {File|Blob} file
 */
export function changeModelPreview(type, name, file) {
    const fd = new FormData();
    fd.append("type", type);
    fd.append("name", name);
    fd.append("file", file);
    return request("/api/wfm/models/change-preview", { method: "POST", body: fd });
}

/** GET /api/wfm/models/filepath?type=&name= → `{path}`. */
export function getModelFilePath(type, name) {
    return request("/api/wfm/models/filepath", { query: { type, name } });
}

/** GET /api/wfm/models/disabled?type= → `["a.safetensors", …]` (.disabled stripped). */
export function getDisabledModels(type) {
    return request("/api/wfm/models/disabled", { query: { type } });
}

/** POST /api/wfm/models/toggle → `{status:"ok", enabled}`. */
export function toggleModelEnabled(modelType, modelName, enabled) {
    return request("/api/wfm/models/toggle", {
        method: "POST",
        body: { model_type: modelType, model_name: modelName, enabled },
    });
}

/** POST /api/wfm/models/group-toggle → `{status, enabled, ok:[names], errors:[…]}`. */
export function toggleGroupEnabled(modelType, groupName, enabled) {
    return request("/api/wfm/models/group-toggle", {
        method: "POST",
        body: { model_type: modelType, group_name: groupName, enabled },
    });
}

/** GET /api/wfm/models/files?type= → sorted relative paths (`/`-separated). */
export function listModelFiles(type) {
    return request("/api/wfm/models/files", { query: { type } });
}

/** GET /api/wfm/models/subdirs?type= → sorted subdirectory names. */
export function getSubdirs(type) {
    return request("/api/wfm/models/subdirs", { query: { type } });
}

/** POST /api/wfm/models/move → `{moved:[{from,to}], errors:[…]}`; `dest:""` = root. */
export function moveModels(modelType, modelNames, dest) {
    return request("/api/wfm/models/move", {
        method: "POST",
        body: { model_type: modelType, model_names: modelNames, dest },
    });
}

/** POST /api/wfm/models/delete → `{status, ok:[{model,deleted}], errors:[{model,error}]}`. */
export function deleteModels(modelType, modelNames) {
    return request("/api/wfm/models/delete", {
        method: "POST",
        body: { model_type: modelType, model_names: modelNames },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gallery (py/routes/gallery_routes.py) — NOTE: these paths carry NO `/api` prefix.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL (binary image, `Cache-Control: max-age=3600`) for `GET /wfm/gallery/image/serve`.
 * Suitable for `<img src>` / `<video src>`.
 */
export function galleryServeUrl(path) {
    return buildUrl("/wfm/gallery/image/serve", { path });
}

/**
 * URL (binary JPEG/GIF thumbnail, `Cache-Control: max-age=86400`) for
 * `GET /wfm/gallery/image/thumb`. `w` is clamped server-side to 32…512 (default 256).
 */
export function galleryThumbUrl(path, w = 256) {
    return buildUrl("/wfm/gallery/image/thumb", { path, w });
}

/** GET /wfm/gallery/folders?root= → folder-tree node (also configures the gallery root). */
export function listGalleryFolders(root) {
    return request("/wfm/gallery/folders", { query: { root } });
}

/**
 * GET /wfm/gallery/images → `{images:[{filename,path,size,mtime,ext,favorite,tags,memo,groups}], total}`.
 * @param {{folder:string, search?:string, sort?:string, favorite?:any, tag?:string,
 *          group?:string, recursive?:any, signal?:AbortSignal}} params `folder` is required.
 */
export function listGalleryImages(params) {
    const { signal, ...query } = params || {};
    return request("/wfm/gallery/images", { query, signal });
}

/** GET /wfm/gallery/image/meta?path= → gallery metadata object for one image. */
export function getGalleryImageMeta(path) {
    return request("/wfm/gallery/image/meta", { query: { path } });
}

/** GET /wfm/gallery/image/workflow?path= → `{workflow, has_workflow, prompt_workflow}`. */
export function getGalleryImageWorkflow(path) {
    return request("/wfm/gallery/image/workflow", { query: { path } });
}

/**
 * POST /wfm/gallery/image/meta → `{ok:boolean}`.
 * Caveat: the server answers 200 even when it rejects the save; callers must
 * check `ok` (or `error`) themselves.
 */
export function saveGalleryImageMeta(path, meta) {
    return request("/wfm/gallery/image/meta", {
        method: "POST",
        body: { path, ...(meta || {}) },
    });
}

/** GET /wfm/gallery/image-prompt/root → `{root}`; 500 when the output dir is unresolved. */
export function getImagePromptRoot() {
    return request("/wfm/gallery/image-prompt/root");
}

/** POST /wfm/gallery/image/image-prompt → `{ok}` (writes the `.txt` sidecar). */
export function saveImagePrompt(path, prompt) {
    return request("/wfm/gallery/image/image-prompt", {
        method: "POST",
        body: { path, prompt },
    });
}

/** GET /wfm/gallery/style-catalog/root → `{root}`; 500 when unresolved. */
export function getStyleCatalogRoot() {
    return request("/wfm/gallery/style-catalog/root");
}

/**
 * POST /wfm/gallery/image/save → `{ok:true, path}`. Saves a data-URL image into
 * the gallery root; fails with 500 until the gallery root is configured (open
 * Gallery / set the output dir first).
 * @param {{filename:string, imageData:string}} payload data URL (PNG assumed when header-less)
 */
export function saveImageToGallery(payload) {
    return request("/wfm/gallery/image/save", { method: "POST", body: payload });
}

/**
 * POST /wfm/gallery/image/save-to-folder → `{ok:true, path}` (overwrites same name).
 * @param {{folder:string, filename:string, imageData:string}} payload
 */
export function saveImageToFolder(payload) {
    return request("/wfm/gallery/image/save-to-folder", { method: "POST", body: payload });
}

/**
 * POST /wfm/gallery/output-image/delete → `{ok:true}`. Deletes a ComfyUI output
 * file addressed as `{filename, subfolder, type}`; `type` must be `"output"`.
 */
export function deleteOutputImage(payload) {
    return request("/wfm/gallery/output-image/delete", { method: "POST", body: payload });
}

/** POST /wfm/gallery/image/favorite → `{favorite:boolean}`. */
export function toggleGalleryFavorite(path) {
    return request("/wfm/gallery/image/favorite", { method: "POST", body: { path } });
}

/** GET /wfm/gallery/groups → `{groups:[…]}`. */
export function listGalleryGroups() {
    return request("/wfm/gallery/groups");
}

/** POST /wfm/gallery/groups → `{ok:true}`; 409 when the group already exists. */
export function createGalleryGroup(name) {
    return request("/wfm/gallery/groups", { method: "POST", body: { name } });
}

/** PUT /wfm/gallery/groups/{name} → `{ok:true}`; body `{new_name}`. */
export function renameGalleryGroup(name, newName) {
    return request(`/wfm/gallery/groups/${seg(name)}`, {
        method: "PUT",
        body: { new_name: newName },
    });
}

/** DELETE /wfm/gallery/groups/{name} → `{ok}`; 403 for reserved groups. */
export function deleteGalleryGroup(name) {
    return request(`/wfm/gallery/groups/${seg(name)}`, { method: "DELETE" });
}

/** POST /wfm/gallery/groups/ensure → `{ok:true}` (idempotent create). */
export function ensureGalleryGroup(name) {
    return request("/wfm/gallery/groups/ensure", { method: "POST", body: { name } });
}

/** POST /wfm/gallery/groups/{name}/add → `{ok}`. */
export function addToGalleryGroup(name, path) {
    return request(`/wfm/gallery/groups/${seg(name)}/add`, {
        method: "POST",
        body: { path },
    });
}

/** POST /wfm/gallery/groups/{name}/remove → `{ok}`. */
export function removeFromGalleryGroup(name, path) {
    return request(`/wfm/gallery/groups/${seg(name)}/remove`, {
        method: "POST",
        body: { path },
    });
}

/** POST /wfm/gallery/groups/{name}/clear → `{ok}` (no body). */
export function clearGalleryGroup(name) {
    return request(`/wfm/gallery/groups/${seg(name)}/clear`, { method: "POST" });
}

/** GET /wfm/gallery/groups/{name}/images → `{images:[…]}`. */
export function listGalleryGroupImages(name) {
    return request(`/wfm/gallery/groups/${seg(name)}/images`);
}

/** POST /wfm/gallery/bulk/favorite → service result; the count is `data.ok` (a number). */
export function bulkGalleryFavorite(paths, value) {
    return request("/wfm/gallery/bulk/favorite", {
        method: "POST",
        body: { paths, value },
    });
}

/** POST /wfm/gallery/bulk/group → service result; `data.ok` count + `data.errors`. */
export function bulkGalleryGroup(paths, group, action) {
    return request("/wfm/gallery/bulk/group", {
        method: "POST",
        body: { paths, group, action },
    });
}

/** POST /wfm/gallery/folder → `{ok, …}`; body `{parent, name}` (400 → `{ok:false,error}`). */
export function createGalleryFolder(parent, name) {
    return request("/wfm/gallery/folder", { method: "POST", body: { parent, name } });
}

/** DELETE /wfm/gallery/folder → `{ok, …}`; body `{path}`. */
export function deleteGalleryFolder(path) {
    return request("/wfm/gallery/folder", { method: "DELETE", body: { path } });
}

/** POST /wfm/gallery/images/delete → `{deleted:[…], errors:[…]}`. */
export function deleteGalleryImages(paths) {
    return request("/wfm/gallery/images/delete", { method: "POST", body: { paths } });
}

/** POST /wfm/gallery/images/move → `{moved:[{from,to}], errors:[…]}`. */
export function moveGalleryImages(paths, dest) {
    return request("/wfm/gallery/images/move", { method: "POST", body: { paths, dest } });
}

/** URL of `POST /wfm/gallery/images/export-zip` (POST-only; use `exportGalleryZip`). */
export function galleryExportZipUrl() {
    return "/wfm/gallery/images/export-zip";
}

/** URL of `POST /wfm/gallery/images/export-psd` (POST-only; use `exportGalleryPsd`). */
export function galleryExportPsdUrl() {
    return "/wfm/gallery/images/export-psd";
}

/**
 * POST /wfm/gallery/images/export-zip → Blob (`gallery_export.zip`).
 * The endpoint is POST-only, so a plain URL cannot be used on an `<a href>`;
 * the caller wraps the Blob in an object URL.
 */
export function exportGalleryZip(paths, opts = {}) {
    return requestBlob("/wfm/gallery/images/export-zip", {
        body: { paths },
        signal: opts.signal,
    });
}

/** POST /wfm/gallery/images/export-psd → Blob (`image/vnd.adobe.photoshop`). */
export function exportGalleryPsd(paths, opts = {}) {
    return requestBlob("/wfm/gallery/images/export-psd", {
        body: { paths },
        signal: opts.signal,
    });
}

/** POST /wfm/gallery/image/export-psd-layers → Blob (PSD built from `{width,height,layers}`). */
export function exportPsdLayers(payload, opts = {}) {
    return requestBlob("/wfm/gallery/image/export-psd-layers", {
        body: payload,
        signal: opts.signal,
    });
}

/** POST /wfm/gallery/image/import-psd-layers (multipart field `file`) → layers JSON. */
export function importPsdLayers(file) {
    const fd = new FormData();
    fd.append("file", file);
    return request("/wfm/gallery/image/import-psd-layers", { method: "POST", body: fd });
}

/** GET /wfm/gallery/image/psd-layers?path= → layers JSON. */
export function getPsdLayers(path) {
    return request("/wfm/gallery/image/psd-layers", { query: { path } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Eagle (py/routes/eagle_routes.py)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/wfm/eagle/add — the Eagle API response is passed through.
 * @param {{eagleUrl:string, url:string, name:string, tags:string[],
 *          filename?:string, subfolder?:string, type?:string, localPath?:string}} payload
 */
export function eagleAdd(payload) {
    return request("/api/wfm/eagle/add", { method: "POST", body: payload });
}

/** POST /api/wfm/eagle/test → `{status, connected, version?|message?}`. */
export function testEagle(eagleUrl) {
    return request("/api/wfm/eagle/test", { method: "POST", body: { eagleUrl } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama proxy (py/routes/ollama_routes.py) — used by the Workflow AI summary
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/wfm/ollama/chat → `{status:"success", message}`. */
export function ollamaChat(messages, opts = {}) {
    const body = { messages };
    if (opts.url !== undefined) body.url = opts.url;
    if (opts.model !== undefined) body.model = opts.model;
    return request("/api/wfm/ollama/chat", { method: "POST", body, signal: opts.signal });
}

/** GET /api/wfm/ollama/models → `{status:"success", models:[…]}` (URL/model come from settings). */
export function ollamaModels() {
    return request("/api/wfm/ollama/models");
}

/** POST /api/wfm/ollama/test → `{connected, message}` (URL comes from settings). */
export function testOllama() {
    return request("/api/wfm/ollama/test", { method: "POST" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Not implemented on purpose (tabs absent from the new UI)
// ─────────────────────────────────────────────────────────────────────────────
// nodes_routes.py    (9)  GET/POST /api/wfm/nodes/{metadata,groups},
//                         /api/wfm/node-sets{,/update,/delete,/export}
// tagger_routes.py   (17) /wfm/tagger/**  (models, predict, vlm, batch, db)
// lab_routes.py      (5)  /api/wfm/lab/plans*, /api/wfm/lab/index-image/save-to-output
// video_routes.py    (12) /api/wfm/video/** (frame, to-gif, edit, plans, projects)
// gmic_routes.py     (3)  /api/wfm/gmic/{open,status/{job_id},result}
// unsloth_routes.py  (1)  /api/wfm/unsloth/proxy            (AI TOOL tab)
// skill_routes.py    (4)  /api/wfm/skills*                  (AI TOOL tab)
