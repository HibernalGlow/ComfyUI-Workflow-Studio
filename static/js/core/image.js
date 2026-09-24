/**
 * core/image.js — output directory, result metadata and blob helpers.
 *
 * Port of generate-tab.js `_fetchOutputDir` (L24-32), `saveGeneratedImagesMeta` (L34-52),
 * `_blobToDataUrl` (L1728-1735), `_flattenFolderTree` (L1737-1741) and
 * `_applyDefaultCheckpointIfEnabled` (L204-221) minus DOM and minus module state:
 *  - upstream kept `let _outputDir = ""` module-level and mirrored the Settings tab's live update
 *    (`wfm-output-dir-changed`) into it; the directory is now a parameter the view owns, and
 *    `normalizeOutputDir` is exported so the view can apply the same normalisation to that event;
 *  - `showToast(t("defaultCheckpointApplied", name))` becomes the returned checkpoint name;
 *  - `_blobToDataUrl` used the browser reader API; this port uses `blob.arrayBuffer()` plus a
 *    pure base64 encoder, so the module also runs in Node without any browser global.
 *
 * Requires from ./api.js:
 *   getOutputDir() -> {current, default, saved}          // GET /api/wfm/settings/output-dir
 *   getSettingsFromServer() -> {default_checkpoint_enabled, default_checkpoint_name, ...}
 *   saveGalleryImageMeta(path, meta)                     // POST /wfm/gallery/image/meta (no /api)
 */

import * as api from "./api.js";

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `\` -> `/` and one trailing slash stripped (upstream did this at every `_outputDir` write). */
export function normalizeOutputDir(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/$/, "");
}

/**
 * `GET /api/wfm/settings/output-dir`, normalised. All errors swallowed (upstream behaviour),
 * so a failed refresh returns "" and the caller can keep its previous value.
 * @returns {Promise<string>}
 */
export async function fetchOutputDir() {
    try {
        const data = await api.getOutputDir();
        return normalizeOutputDir(data?.current);
    } catch {
        return "";
    }
}

/** Absolute-ish gallery path of one ComfyUI history image entry (`{filename, subfolder, type}`). */
export function imageOutputPath(image, outputDir) {
    const parts = [normalizeOutputDir(outputDir)];
    if (image?.subfolder) parts.push(image.subfolder);
    parts.push(image?.filename || "");
    return parts.join("/");
}

/**
 * Attach the producing workflow to every SAVED result image
 * (upstream skipped anything whose `type !== "output"`; previews never get metadata).
 * Upstream passed the BASE workflow - pre-style, pre-wildcard, pre-seed - so keep doing that.
 *
 * @param {Array<{filename:string, subfolder?:string, type?:string}>} images history images
 * @param {object} workflow payload stored under `workflow`
 * @param {{outputDir?:string}} [options] pre-fetched dir; fetched on demand when omitted
 * @returns {Promise<{saved:number, failed:number}>} never rejects
 */
export async function saveGeneratedImagesMeta(images, workflow, { outputDir = "" } = {}) {
    const dir = outputDir || (await fetchOutputDir());
    if (!dir) return { saved: 0, failed: 0 };

    let saved = 0;
    let failed = 0;
    for (const image of images || []) {
        if (image?.type !== "output") continue;
        try {
            await api.saveGalleryImageMeta(imageOutputPath(image, dir), { workflow });
            saved++;
        } catch {
            failed++;
        }
    }
    return { saved, failed };
}

/**
 * Port of `_applyDefaultCheckpointIfEnabled`: replace the checkpoint of every checkpoint-loader
 * node with the server-configured default. MUST run before `comfyWorkflow.analyzeWorkflow()`,
 * otherwise the analysis (and every node lookup by id) sees the old name.
 *
 * @param {object} apiWorkflow API-format workflow, mutated in place
 * @returns {Promise<string|null>} the applied checkpoint name, or null when disabled / on error
 */
export async function applyDefaultCheckpointIfEnabled(apiWorkflow) {
    try {
        const settings = await api.getSettingsFromServer();
        if (!settings?.default_checkpoint_enabled || !settings?.default_checkpoint_name) return null;

        let applied = false;
        for (const node of Object.values(apiWorkflow || {})) {
            const classType = node?.class_type || "";
            const isCheckpointLoader = classType.includes("CheckpointLoader")
                || classType === "Checkpoint Loader"
                || classType === "ImageMetadataPromptLoader";
            if (node?.inputs && isCheckpointLoader) {
                node.inputs.ckpt_name = settings.default_checkpoint_name;
                applied = true;
            }
        }
        return applied ? settings.default_checkpoint_name : null;
    } catch {
        return null;
    }
}

function bytesToBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        out += BASE64_CHARS[b0 >> 2];
        out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
        out += b1 === undefined ? "=" : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
        out += b2 === undefined ? "=" : BASE64_CHARS[b2 & 0x3f];
    }
    return out;
}

/**
 * Blob -> `data:<type>;base64,...` (upstream `_blobToDataUrl`, without the browser reader API).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = blob.type || "application/octet-stream";
    return `data:${type};base64,${bytesToBase64(bytes)}`;
}

/**
 * Flatten a gallery folder tree `{path, abs_path, children[]}` into `[{path, abs_path}]`.
 * The root node is labelled `[root]` and its own `path` is discarded (upstream behaviour).
 */
export function flattenFolderTree(node, acc = [], isRoot = true) {
    acc.push({ path: isRoot ? "[root]" : node.path, abs_path: node.abs_path });
    (node.children || []).forEach((child) => flattenFolderTree(child, acc, false));
    return acc;
}
