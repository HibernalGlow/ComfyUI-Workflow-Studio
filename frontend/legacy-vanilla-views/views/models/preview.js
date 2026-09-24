/**
 * views/models/preview.js — model thumbnail loading (brief §4 item 17).
 *
 * The preview endpoint is a **binary** GET exposed by core as a URL builder
 * (`api.modelPreviewUrl`); it is never fetched. "No preview" is therefore detected
 * with `img.onload` / `img.onerror` — upstream's note applies: aiohttp's `add_get`
 * does not auto-handle `HEAD`, so a HEAD probe is not usable. On error the cached
 * CivitAI sample image is tried before the placeholder is shown.
 *
 * Loading is deferred until a thumbnail scrolls into view (IntersectionObserver,
 * with an immediate fallback where the API is missing), which is what makes the
 * grid cheap for large model folders.
 */
import { api, models as coreModels } from "../../core/index.js";
import { tr } from "./state.js";

/** The local preview URL for a model (binary; put it on an `<img>`). */
export function previewUrl(type, name) {
    return api.modelPreviewUrl(type, name);
}

/** Cache-buster for a freshly uploaded / fetched thumbnail. */
export function cacheBusted(url) {
    return `${url}&t=${Date.now()}`;
}

/** First CivitAI sample image of a model, or "" (used as the preview fallback). */
export function civitaiImageUrl(state, name) {
    const entry = coreModels.entryOf(state.modelMetadata, name);
    const record = coreModels.civitaiFor(state.civitaiCache, { sha256: entry.sha256, name });
    const images = record?.images;
    return Array.isArray(images) && images[0] ? String(images[0]) : "";
}

/** A thumbnail cell: hidden `<img>` + placeholder, both wired by `loadPreview`. */
export function createThumb(ui, name, { alt = "", type = "" } = {}) {
    const root = document.createElement("div");
    root.className = "nu-models-thumb";
    const img = document.createElement("img");
    img.className = "nu-models-thumb__img";
    img.alt = alt || name;
    img.decoding = "async";
    img.hidden = true;
    img.dataset.nuPreview = name;
    if (type) img.dataset.nuPreviewType = type;
    const placeholder = document.createElement("span");
    placeholder.className = "nu-models-thumb__placeholder";
    placeholder.textContent = tr("modelsNoPreview", "No preview");
    root.append(img, placeholder);
    return { root, img, placeholder };
}

/**
 * Wire one `<img>`: local preview first, CivitAI image on error, placeholder last.
 * The model type is read from the state unless `type` is given.
 */
export function loadPreviewImage(ui, img, placeholder, name, { type = "" } = {}) {
    const state = ui.store.getState();
    const modelType = type || state.activeModelType;
    const fallback = civitaiImageUrl(state, name);
    img.onload = () => {
        img.hidden = false;
        if (placeholder) placeholder.hidden = true;
    };
    img.onerror = () => {
        img.onerror = () => {
            img.hidden = true;
            if (placeholder) placeholder.hidden = false;
        };
        if (fallback) {
            img.hidden = false;
            if (placeholder) placeholder.hidden = true;
            img.src = fallback;
        } else {
            img.hidden = true;
            if (placeholder) placeholder.hidden = false;
        }
    };
    img.src = previewUrl(modelType, name);
    return img;
}

/** Force a reload (after a CivitAI fetch or a thumbnail upload). */
export function reloadPreview(ui, img, name, { type = "", url = "" } = {}) {
    if (!img) return;
    const state = ui.store.getState();
    const modelType = type || state.activeModelType;
    if (url) {
        img.src = url;
        img.hidden = false;
        return;
    }
    const local = cacheBusted(previewUrl(modelType, name));
    const fallback = civitaiImageUrl(state, name);
    img.onerror = () => {
        if (fallback) img.src = fallback;
        else img.hidden = true;
    };
    img.onload = () => {
        img.hidden = false;
    };
    img.src = local;
}

/**
 * Start every not-yet-loaded `img[data-nu-preview]` inside `root`, deferred to the
 * moment it enters the viewport. Safe to call after every re-render: each image is
 * tagged once, so no duplicate requests are issued.
 */
export function attachLazyPreviews(root, ui) {
    const images = root.querySelectorAll("img[data-nu-preview]");
    if (images.length === 0) return () => {};

    const start = (img) => {
        if (img.dataset.nuPreviewStarted === "1") return;
        img.dataset.nuPreviewStarted = "1";
        const placeholder = img.closest(".nu-models-thumb")?.querySelector(".nu-models-thumb__placeholder") || null;
        loadPreviewImage(ui, img, placeholder, img.dataset.nuPreview, {
            type: img.dataset.nuPreviewType || "",
        });
    };

    if (typeof IntersectionObserver !== "function") {
        images.forEach(start);
        return () => {};
    }

    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                start(entry.target);
                observer.unobserve(entry.target);
            }
        },
        { root: null, rootMargin: "200px" },
    );
    images.forEach((img) => observer.observe(img));
    return () => observer.disconnect();
}
