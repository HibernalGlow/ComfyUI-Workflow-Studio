/**
 * views/gallery/preview.js — large image viewer built on the dialog host.
 *
 * Opened from a grid tile. Besides the big image (`galleryServeUrl`) it owns the
 * per-image actions that need the meta endpoints:
 *   - favourite toggle        → api.toggleGalleryFavorite
 *   - memo / tags editing     → api.getGalleryImageMeta + api.saveGalleryImageMeta
 *   - workflow restore        → api.getGalleryImageWorkflow ({workflow, has_workflow,
 *                               prompt_workflow}); "Restore" pushes the graph into the
 *                               app store so Generate/Workflow can adopt it, and the
 *                               button is visibly disabled when `has_workflow` is false.
 *
 * Keyboard: Esc closes (the host's trap), ArrowLeft/ArrowRight move to the previous /
 * next image. Arrow keys are ignored while a field has focus so caret movement works.
 *
 * Store handoff written here:
 *   ctx.store.setState({ workflow, workflowName, workflowSource: "gallery" })
 */

import { api, t } from "../../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createIconButton } from "../../components/IconButton.js";
import { createTextField } from "../../components/TextField.js";
import { openDialog } from "../../dialog.js";
import { showSnackbar } from "../../snackbar.js";
import { announce, restoreFocus } from "../../a11y.js";

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function isVideo(image) {
    const source = String((image && (image.ext || image.filename || image.path)) || "");
    return source.toLowerCase().endsWith(".mp4");
}

function tagsToText(tags) {
    return Array.isArray(tags) ? tags.join(", ") : "";
}

function textToTags(value) {
    return String(value || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
}

/**
 * @param {{images:Array<object>, index:number, ctx:object, onChanged?:(img:object)=>void}} opts
 */
export async function openImageViewer(opts) {
    const images = Array.isArray(opts.images) ? opts.images : [];
    if (images.length === 0) return;
    const ctx = opts.ctx || {};
    let index = Math.min(Math.max(opts.index | 0, 0), images.length - 1);
    let token = 0;
    let closed = false;
    const workflowCache = new Map();

    // ── stage ───────────────────────────────────────────────────────────────
    const stage = el("div", "nu-gallery__stage");
    stage.style.cssText =
        "position:relative;display:flex;align-items:center;justify-content:center;" +
        "min-height:36vh;max-height:62vh;overflow:auto";
    const prevBtn = createIconButton({
        icon: "◀",
        ariaLabel: "Previous image",
        title: "Previous image",
        onClick: () => step(-1),
    });
    const nextBtn = createIconButton({
        icon: "▶",
        ariaLabel: "Next image",
        title: "Next image",
        onClick: () => step(1),
    });
    prevBtn.style.cssText = nextBtn.style.cssText = "position:absolute;top:50%;transform:translateY(-50%)";
    prevBtn.style.left = "8px";
    nextBtn.style.right = "8px";

    const title = el("p", "nu-gallery__viewer-title");
    const counter = el("p", "nu-muted", "");
    const favBtn = createIconButton({
        icon: "☆",
        ariaLabel: t("favorite"),
        title: t("favorite"),
        toggle: true,
        pressed: false,
        onClick: () => toggleFavorite(),
    });

    const memoField = createTextField({
        label: t("memo"),
        placeholder: t("memoPlaceholder"),
        multiline: true,
        rows: 3,
    });
    const tagsField = createTextField({ label: t("tags"), placeholder: "tag1, tag2" });
    const workflowBadge = el("span", "nu-badge", "…");
    const restoreBtn = createButton({
        label: "Restore workflow",
        variant: "tonal",
        disabled: true,
        onClick: () => restoreWorkflow(),
    });
    const copyJsonBtn = createButton({
        label: "Copy workflow JSON",
        variant: "text",
        disabled: true,
        onClick: () => copyWorkflowJson(),
    });
    const saveBtn = createButton({ label: t("save"), variant: "filled", onClick: () => saveMeta() });

    const metaBox = el("div", "nu-gallery__meta");
    metaBox.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:min(520px,80vw)";
    const metaRow = el("div", "nu-row");
    metaRow.append(workflowBadge, restoreBtn, copyJsonBtn);
    const actionRow = el("div", "nu-row");
    actionRow.append(saveBtn, el("span", "nu-spacer"), counter);
    metaBox.append(title, memoField.root, tagsField.root, metaRow, actionRow);

    const content = el("div", "nu-gallery__viewer");
    content.style.cssText = "display:flex;flex-direction:column;gap:12px";
    const headerRow = el("div", "nu-row");
    headerRow.append(el("span", "nu-spacer"), favBtn);
    stage.append(prevBtn, nextBtn);
    content.append(stage, headerRow, metaBox);

    // ── helpers ─────────────────────────────────────────────────────────────
    function current() {
        return images[index];
    }

    function renderStage() {
        const image = current();
        if (!image) return;
        const source = api.galleryServeUrl(image.path);
        stage.querySelector("img, video")?.remove();
        const media = isVideo(image)
            ? document.createElement("video")
            : document.createElement("img");
        media.className = "nu-gallery__stage-media";
        media.style.cssText = "max-width:100%;max-height:58vh;object-fit:contain";
        if (isVideo(image)) {
            media.controls = true;
            media.preload = "metadata";
        } else {
            media.alt = String(image.filename || "");
        }
        media.src = source;
        stage.insertBefore(media, prevBtn);

        title.textContent = String(image.filename || "");
        counter.textContent = `${index + 1} / ${images.length}`;
        favBtn.setAttribute("aria-label", `${t("favorite")}: ${image.filename}`);
        const fav = !!image.favorite;
        favBtn.classList.toggle("m3-icon-btn--filled", fav);
        favBtn.setAttribute("aria-pressed", fav ? "true" : "false");
        prevBtn.disabled = index === 0;
        nextBtn.disabled = index === images.length - 1;
    }

    async function loadDetail() {
        const image = current();
        if (!image) return;
        const myToken = ++token;
        memoField.setValue(image.memo || "");
        tagsField.setValue(tagsToText(image.tags));
        workflowBadge.textContent = t("loading");
        restoreBtn.disabled = true;
        copyJsonBtn.disabled = true;

        const cached = workflowCache.get(image.path);
        try {
            const [meta, detail] = cached
                ? [cached.meta, cached.workflow]
                : await Promise.all([
                    api.getGalleryImageMeta(image.path),
                    api.getGalleryImageWorkflow(image.path),
                ]);
            if (closed || myToken !== token) return;
            workflowCache.set(image.path, { meta, workflow: detail });

            if (meta) {
                if (!memoField.getValue() && typeof meta.memo === "string") memoField.setValue(meta.memo);
                if (!tagsField.getValue() && Array.isArray(meta.tags)) tagsField.setValue(tagsToText(meta.tags));
                if (meta.image_prompt && !memoField.getValue()) memoField.setValue(String(meta.image_prompt));
            }
            const hasWorkflow = !!(detail && detail.has_workflow);
            workflowBadge.textContent = hasWorkflow ? "Workflow embedded" : "No workflow embedded";
            restoreBtn.disabled = !hasWorkflow;
            restoreBtn.title = hasWorkflow ? "Push this graph into Generate/Workflow" : "This image has no embedded workflow";
            copyJsonBtn.disabled = !hasWorkflow;
        } catch (e) {
            if (closed || myToken !== token) return;
            workflowBadge.textContent = "No workflow embedded";
            restoreBtn.disabled = true;
            copyJsonBtn.disabled = true;
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    function step(delta) {
        const target = index + delta;
        if (target < 0 || target >= images.length) return;
        index = target;
        renderStage();
        loadDetail();
        announce(`${index + 1} / ${images.length} ${current()?.filename || ""}`);
    }

    async function toggleFavorite() {
        const image = current();
        if (!image) return;
        try {
            const res = await api.toggleGalleryFavorite(image.path);
            const favorite = res && typeof res.favorite === "boolean" ? res.favorite : !image.favorite;
            image.favorite = favorite;
            renderStage();
            if (typeof opts.onChanged === "function") opts.onChanged(image);
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    async function saveMeta() {
        const image = current();
        if (!image) return;
        const memo = memoField.getValue();
        const tags = textToTags(tagsField.getValue());
        try {
            const res = await api.saveGalleryImageMeta(image.path, { memo, tags });
            // The endpoint answers 200 even when the server rejected the write.
            if (!res || res.ok === false || res.error) {
                throw new Error((res && res.error) || "Save rejected by server");
            }
            image.memo = memo;
            image.tags = tags;
            if (typeof opts.onChanged === "function") opts.onChanged(image);
            showSnackbar({ label: t("savedAs", image.filename), timeout: 3000 });
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    async function restoreWorkflow() {
        const image = current();
        if (!image) return;
        try {
            const cached = workflowCache.get(image.path);
            const detail = cached ? cached.workflow : await api.getGalleryImageWorkflow(image.path);
            workflowCache.set(image.path, { meta: cached && cached.meta, workflow: detail });
            if (!detail || !detail.has_workflow || !detail.workflow) {
                showSnackbar({ label: "This image has no embedded workflow", timeout: 4000 });
                loadDetail();
                return;
            }
            const store = ctx.store;
            if (!store || typeof store.setState !== "function") {
                showSnackbar({ label: "Store unavailable", timeout: 4000 });
                return;
            }
            store.setState({
                workflow: detail.workflow,
                workflowName: String(image.filename || ""),
                workflowSource: "gallery",
            });
            showSnackbar({ label: `Workflow restored from ${image.filename}`, timeout: 3500 });
            if (typeof ctx.navigate === "function") ctx.navigate("generate");
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    async function copyWorkflowJson() {
        const image = current();
        if (!image) return;
        const cached = workflowCache.get(image.path);
        const detail = cached ? cached.workflow : await api.getGalleryImageWorkflow(image.path).catch(() => null);
        if (!detail || !detail.workflow) {
            showSnackbar({ label: "This image has no embedded workflow", timeout: 4000 });
            return;
        }
        try {
            await navigator.clipboard.writeText(JSON.stringify(detail.workflow, null, 2));
            showSnackbar({ label: t("copiedToClipboard"), timeout: 3000 });
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    function onKey(event) {
        if (closed) return;
        const tag = String((event.target && event.target.tagName) || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
        else if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    }

    const trigger = document.activeElement;
    renderStage();
    loadDetail();
    document.addEventListener("keydown", onKey);

    const image = current();
    const pending = openDialog({
        title: image ? String(image.filename || "") : "Image",
        content,
        actions: [{ label: t("close"), variant: "text" }],
        wide: true,
        onClose: () => {
            closed = true;
            token++;
            document.removeEventListener("keydown", onKey);
            restoreFocus(trigger);
        },
    });
    return pending;
}

export default openImageViewer;
