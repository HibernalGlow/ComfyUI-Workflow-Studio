/**
 * views/models/civitai.js — CivitAI integration (brief §4 item 9).
 *
 * Three flows, all through `core`:
 *   - cache       : `models.loadCivitaiCache()` (whole map, keyed by sha256 ‖ name)
 *   - single fetch: `api.fetchCivitai(type, name)` → cache write + sha256 back-fill
 *   - batch fetch : `api.batchCivitai(type, models, onProgress, signal)` — SSE, rendered
 *                   with a `Progress` linear bar and a cancel button wired to an
 *                   `AbortController` (core rejects with `name === "AbortError"`).
 *
 * The cached record is only ever read for: type, baseModel, images[0], trainedWords,
 * modelId/versionId/modelUrl, fileHashes.BLAKE3|SHA256, modelName, versionName, creator,
 * tags, description — the same subset upstream rendered.
 */
import { api, models as coreModels } from "../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createLinearProgress } from "../../components/Progress.js";
import { createSegmentedButtons } from "../../components/SegmentedButtons.js";
import { commit, tr } from "./state.js";

const UNAVAILABLE = "—";

/* --------------------------------------------------------------- cache load */

export async function loadCache(ui) {
    try {
        const cache = await coreModels.loadCivitaiCache();
        ui.store.getState().civitaiCache = cache && typeof cache === "object" ? cache : {};
    } catch {
        ui.store.getState().civitaiCache = {};
    }
    return ui.store.getState().civitaiCache;
}

export function recordFor(state, name) {
    const entry = coreModels.entryOf(state.modelMetadata, name);
    return coreModels.civitaiFor(state.civitaiCache, { sha256: entry.sha256, name });
}

/* ------------------------------------------------------------- single fetch */

/** Fetch one model, write cache + sha256, refresh the previews (upstream flow). */
export async function fetchForModel(ui, name, { onStatus } = {}) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    onStatus?.(tr("civitaiHashing", "Hashing…"));
    try {
        const data = await api.fetchCivitai(type, name);
        if (data?.status === "ok" && data.civitai) {
            if (data.sha256) {
                state.civitaiCache[data.sha256] = data.civitai;
                if (!state.modelMetadata[name]) state.modelMetadata[name] = {};
                state.modelMetadata[name].sha256 = data.sha256;
            }
            ui.snack(tr("civitaiFound", "Found on CivitAI"), "success");
            commit(ui.store);
            ui.refreshPreviews?.(name, data.preview_saved);
            return { status: "ok", record: data.civitai };
        }
        if (data?.status === "not_found") {
            onStatus?.(tr("civitaiNotFound", "Not found on CivitAI"));
            return { status: "not_found" };
        }
        onStatus?.(data?.error || tr("civitaiError", "CivitAI error"));
        return { status: "error" };
    } catch (err) {
        onStatus?.(tr("civitaiError", "CivitAI error"));
        ui.snack(`${tr("civitaiError", "CivitAI error")}: ${err.message}`, "error");
        return { status: "error" };
    }
}

/** Drop the cached record + local sha256 so the next fetch re-hashes the file. */
export function forgetRecord(ui, name) {
    const state = ui.store.getState();
    const entry = state.modelMetadata[name];
    if (entry?.sha256) delete state.civitaiCache[entry.sha256];
    if (entry) delete entry.sha256;
    commit(ui.store);
}

/* ---------------------------------------------------------------- rendering */

function row(labelText, valueNode) {
    const line = document.createElement("div");
    line.className = "nu-models-civitai__row";
    const label = document.createElement("span");
    label.className = "nu-models-civitai__label";
    label.textContent = labelText;
    line.append(label, valueNode);
    return line;
}

/** Click / Enter / Space copies `text` and reports back through `onCopied`. */
function copyTarget(node, text, onCopied) {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.title = tr("civitaiCopyHash", "Click to copy");
    node.addEventListener("click", () => {
        const done = () => onCopied?.();
        try {
            navigator.clipboard?.writeText(text).then(done, () => {});
        } catch {
            /* clipboard unavailable — nothing else to do */
        }
    });
    node.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        node.click();
    });
    return node;
}

/** Info pane: name / version / creator / type / base model / hash / tags / words. */
function renderInfoPane(ui, host, name) {
    const state = ui.store.getState();
    const record = recordFor(state, name);
    if (!record) return;
    const url = coreModels.civitaiUrl(record, state.civitaiHost);

    const title = document.createElement("a");
    title.className = "nu-models-civitai__title";
    title.textContent = record.modelName || name;
    if (url) {
        title.href = url;
        title.target = "_blank";
        title.rel = "noopener";
    }
    host.appendChild(title);

    const sub = document.createElement("p");
    sub.className = "nu-muted";
    const creator = record.creator ? ` · by ${record.creator}` : "";
    sub.textContent = `${record.versionName || ""}${creator}`;
    host.appendChild(sub);

    if (record.type) {
        const tag = document.createElement("span");
        tag.className = "nu-badge nu-models-civitai__type";
        tag.textContent = String(record.type).toUpperCase();
        host.appendChild(row(tr("civitaiType", "Type"), tag));
    }
    if (record.baseModel) {
        const value = document.createElement("span");
        value.textContent = record.baseModel;
        host.appendChild(row(tr("civitaiBaseModel", "Base model"), value));
    }

    const hashes = record.fileHashes || {};
    const blake3 = hashes.BLAKE3 || hashes.Blake3 || "";
    const entry = coreModels.entryOf(state.modelMetadata, name);
    const sha = hashes.SHA256 || entry.sha256 || "";
    const full = blake3 || sha;
    if (full) {
        const code = document.createElement("code");
        code.className = "nu-models-civitai__hash";
        code.textContent = `${blake3 ? "BLAKE3" : "SHA256"}: ${String(full).slice(0, 16).toUpperCase()}…`;
        copyTarget(code, full, () => ui.snack(tr("civitaiHashCopied", "Hash copied"), "info"));
        host.appendChild(row(tr("civitaiHashLabel", "Hash"), code));
    }

    const tags = record.tags || [];
    if (tags.length > 0) {
        const wrap = document.createElement("div");
        wrap.className = "nu-models-civitai__tags";
        for (const tag of tags) {
            const chip = document.createElement("span");
            chip.className = "nu-badge";
            chip.textContent = tag;
            wrap.appendChild(chip);
        }
        host.appendChild(wrap);
    }

    const words = record.trainedWords || [];
    if (words.length > 0) {
        const heading = document.createElement("h4");
        heading.textContent = tr("civitaiTriggerWords", "Trigger words");
        host.appendChild(heading);
        const wrap = document.createElement("div");
        wrap.className = "nu-models-civitai__words";
        for (const word of words) {
            const code = document.createElement("code");
            code.textContent = word;
            copyTarget(code, word, () => ui.snack(tr("civitaiWordCopied", "Trigger word copied"), "info"));
            wrap.appendChild(code);
        }
        host.appendChild(wrap);
    }

    if (record.description) {
        const desc = document.createElement("p");
        desc.className = "nu-models-civitai__description";
        desc.textContent = record.description; // text, never markup
        host.appendChild(desc);
    }
}

function renderSamplePane(ui, host, name) {
    const record = recordFor(ui.store.getState(), name);
    const images = record?.images || [];
    if (images.length === 0) {
        const empty = document.createElement("p");
        empty.className = "nu-muted";
        empty.textContent = tr("civitaiNoImages", "No sample images");
        host.appendChild(empty);
        return;
    }
    for (const url of images) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.title = tr("civitaiOpenImage", "Open image");
        const img = document.createElement("img");
        img.className = "nu-models-civitai__sample";
        img.loading = "lazy";
        img.alt = "";
        img.src = url;
        link.appendChild(img);
        host.appendChild(link);
    }
}

/** The CivitAI side-panel pane: three empty states, or the info/sample sub-panes. */
export function renderCivitaiPane(container, ui, name) {
    container.textContent = "";
    const state = ui.store.getState();
    const entry = coreModels.entryOf(state.modelMetadata, name);
    const record = recordFor(state, name);

    if (!record) {
        const empty = document.createElement("div");
        empty.className = "nu-models-civitai__empty";
        const text = document.createElement("p");
        text.className = "nu-muted";
        text.textContent = entry.sha256
            ? tr("civitaiNotFoundDesc", "The file hash is known but CivitAI has no matching model.")
            : tr("civitaiFetchDesc", "No CivitAI data cached for this model yet.");
        empty.appendChild(text);
        const status = document.createElement("p");
        status.className = "nu-muted";
        const button = createButton({
            label: entry.sha256
                ? tr("civitaiRefetchBtn", "Fetch again")
                : tr("civitaiFetch", "Fetch from CivitAI"),
            variant: entry.sha256 ? "tonal" : "filled",
            onClick: async () => {
                button.disabled = true;
                const result = await fetchForModel(ui, name, { onStatus: (msg) => { status.textContent = msg; } });
                button.disabled = false;
                if (result.status === "ok") renderCivitaiPane(container, ui, name);
            },
        });
        empty.append(button, status);
        container.appendChild(empty);
        return;
    }

    const panes = document.createElement("div");
    panes.className = "nu-models-civitai";
    const infoPane = document.createElement("div");
    const samplePane = document.createElement("div");
    samplePane.hidden = true;
    const switcher = createSegmentedButtons({
        segments: [
            { value: "info", label: tr("civitaiTabInfo", "Info") },
            { value: "sample", label: `${tr("civitaiTabSample", "Samples")} (${(record.images || []).length})` },
        ],
        value: "info",
        ariaLabel: tr("civitaiTabInfo", "Info"),
        onChange: (value) => {
            infoPane.hidden = value !== "info";
            samplePane.hidden = value !== "sample";
        },
    });
    renderInfoPane(ui, infoPane, name);
    renderSamplePane(ui, samplePane, name);
    panes.append(switcher.root, infoPane, samplePane);

    panes.appendChild(createButton({
        label: tr("civitaiRefresh", "Refresh"),
        variant: "tonal",
        onClick: async () => {
            forgetRecord(ui, name);
            await fetchForModel(ui, name);
            renderCivitaiPane(container, ui, name);
        },
    }));
    container.appendChild(panes);
}

/* -------------------------------------------------------------- batch (SSE) */

/**
 * Batch controller: a linear progress bar plus a cancel button wired to an
 * `AbortController`. Mounted by the view's toolbar; `start()` fetches every model of
 * the active type that has no cached CivitAI record yet.
 */
export function createCivitaiBatch(ui) {
    const root = document.createElement("div");
    root.className = "nu-models-civitai-batch";
    root.hidden = true;
    root.setAttribute("role", "status");

    const progress = createLinearProgress({ value: 0, ariaLabel: tr("civitaiFetching", "Fetching from CivitAI") });
    const label = document.createElement("span");
    label.className = "nu-models-civitai-batch__label";
    const cancel = createButton({
        label: tr("newui.common.cancel", "Cancel"),
        variant: "text",
        onClick: () => cancelRun(),
    });
    root.append(label, progress.root, cancel);

    let controller = null;

    function cancelRun() {
        controller?.abort();
    }

    const statusText = (status) => {
        if (status === "hashing") return tr("civitaiHashing2", "Hashing");
        if (status === "fetching") return tr("civitaiFetching", "Fetching");
        if (status === "cached" || status === "found") return "✓";
        if (status === "not_found") return UNAVAILABLE;
        return "";
    };

    async function start() {
        const state = ui.store.getState();
        const type = state.activeModelType;
        const models = state.modelsByType[type] || [];
        if (models.length === 0) {
            ui.snack(tr("modelsNoModels", "No models"), "warning");
            return null;
        }
        const uncached = models.filter((name) => !recordFor(state, name));
        if (uncached.length === 0) {
            ui.snack(tr("civitaiBatchAllCached", "All models already have CivitAI data"), "info");
            return null;
        }

        controller = new AbortController();
        state.civitaiRunning = true;
        commit(ui.store);
        root.hidden = false;
        progress.setValue(0);
        label.textContent = `0% (0/${uncached.length})`;

        let done = null;
        try {
            done = await api.batchCivitai(
                type,
                uncached,
                (event) => {
                    const pct = event.total > 0 ? Math.round((event.current / event.total) * 100) : 0;
                    progress.setValue(pct);
                    label.textContent = `${pct}% (${event.current}/${event.total}) ${statusText(event.status)}`;
                },
                controller.signal,
            );
        } catch (err) {
            if (err?.name === "AbortError") ui.snack(tr("newui.common.cancel", "Cancelled"), "info");
            else ui.snack(`${tr("civitaiError", "CivitAI error")}: ${err.message}`, "error");
        } finally {
            controller = null;
            ui.store.getState().civitaiRunning = false;
            root.hidden = true;
            label.textContent = "";
            progress.setValue(0);
        }

        if (done) {
            const note = done.preview_saved > 0 ? ` (+${done.preview_saved})` : "";
            ui.snack(
                `${tr("civitaiBatchDone", "CivitAI batch finished")} — ${done.found} / ${done.not_found}${note}`,
                "success",
            );
            await refreshAfterBatch(ui, done);
        }
        commit(ui.store);
        return done;
    }

    return { root, start, cancel: cancelRun, destroy: cancelRun };
}

/** Reload both caches and back-fill the hashes the `done` frame already knows. */
export async function refreshAfterBatch(ui, done) {
    const [metadata, cache] = await Promise.all([
        coreModels.loadMetadata().catch(() => ({})),
        loadCache(ui),
    ]);
    const state = ui.store.getState();
    const hashes = done?.hashes || {};
    for (const [name, sha256] of Object.entries(hashes)) {
        if (!metadata[name]) metadata[name] = {};
        if (!metadata[name].sha256) metadata[name].sha256 = sha256;
    }
    state.modelMetadata = metadata;
    state.civitaiCache = cache;
    return state;
}
