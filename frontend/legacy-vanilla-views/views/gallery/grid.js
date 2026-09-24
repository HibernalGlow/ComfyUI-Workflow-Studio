/**
 * views/gallery/grid.js — responsive thumbnail grid with incremental loading.
 *
 * Owns the tiles (`<li>` + a focusable `<button>` per image), the multi-select set, the
 * lazy thumbnail loading (IntersectionObserver + `loading="lazy"` on `api.galleryThumbUrl`)
 * and the page-by-page append (PAGE_SIZE tiles at a time, pulled in by a sentinel row and
 * by an explicit "Load more" button so a keyboard user never depends on scrolling).
 *
 * The parent view supplies what happens on activation / favourite toggling:
 *   onOpen(index, image)          — open the large viewer
 *   onToggleFavorite(image)       — single-image favourite round trip
 *   onSelectionChanged(count)     — refresh the bulk bar
 */

import { api, t } from "../../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createIconButton } from "../../components/IconButton.js";

const PAGE_SIZE = 60;
const THUMB_WIDTH = 256;
const TILE_BOX_CSS =
    "position:relative;width:100%;aspect-ratio:1;overflow:hidden;" +
    "border-radius:var(--md-sys-shape-corner-md);background:var(--md-sys-color-surface-container-high)";

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function isVideo(image) {
    return String((image && (image.ext || image.filename)) || "").toLowerCase().endsWith(".mp4");
}

export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {{onOpen:(index:number, image:object)=>void, onToggleFavorite:(image:object)=>void,
 *          onSelectionChanged?:(count:number)=>void}} opts
 */
export function createImageGrid(opts) {
    const root = el("div", "nu-gallery__grid-wrap");
    root.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0";

    const listEl = el("ul", "nu-gallery__grid");
    listEl.setAttribute("aria-label", "Gallery images");
    listEl.style.cssText =
        "list-style:none;margin:0;padding:0;display:grid;" +
        "grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px";

    const emptyMsg = el("p", "nu-empty nu-hidden", "No images found.");
    const footer = el("div", "nu-row");
    const moreBtn = createButton({ label: "Load more", variant: "tonal", onClick: () => appendPage() });
    moreBtn.classList.add("nu-hidden");
    const status = el("p", "nu-muted", "");
    footer.append(moreBtn, el("span", "nu-spacer"), status);
    root.append(listEl, emptyMsg, footer);

    let images = [];
    let total = 0;
    let rendered = 0;
    let selectMode = false;
    let destroyed = false;
    const selected = new Set();
    const lastIndex = { value: -1 };
    const tiles = new Map(); // path → { btn, favBtn, image }
    let thumbObserver = null;
    let sentinelObserver = null;
    let sentinel = null;

    function notify() {
        if (typeof opts.onSelectionChanged === "function") opts.onSelectionChanged(selected.size);
    }

    // ── lazy thumbnails ─────────────────────────────────────────────────────
    function observeThumb(thumb) {
        if (typeof IntersectionObserver !== "function") {
            thumb.src = thumb.dataset.thumb || "";
            delete thumb.dataset.thumb;
            return;
        }
        if (!thumbObserver) {
            thumbObserver = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        const node = entry.target;
                        if (!entry.isIntersecting) continue;
                        if (node.dataset.thumb) {
                            node.src = node.dataset.thumb;
                            delete node.dataset.thumb;
                        }
                        thumbObserver.unobserve(node);
                    }
                },
                { rootMargin: "400px" },
            );
        }
        thumbObserver.observe(thumb);
    }

    // ── paging ──────────────────────────────────────────────────────────────
    function ensureSentinel() {
        if (sentinel) return;
        sentinel = el("li", "nu-gallery__sentinel");
        sentinel.style.cssText = "grid-column:1/-1;height:1px;list-style:none";
        sentinelObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) appendPage();
            },
            { rootMargin: "300px" },
        );
        sentinelObserver.observe(sentinel);
    }

    function appendPage() {
        if (destroyed) return;
        const end = Math.min(rendered + PAGE_SIZE, images.length);
        const fragment = document.createDocumentFragment();
        for (let i = rendered; i < end; i++) fragment.appendChild(tileFor(images[i], i));
        listEl.appendChild(fragment);
        rendered = end;
        const remaining = images.length - rendered;
        moreBtn.classList.toggle("nu-hidden", remaining <= 0);
        status.textContent = images.length
            ? `${rendered} / ${images.length} loaded${total ? ` (${total} total)` : ""}`
            : total ? `${total} total` : "";
        if (remaining > 0) {
            ensureSentinel();
            listEl.appendChild(sentinel); // always last, so the observer fires again
        } else if (sentinel) {
            sentinel.remove();
        }
    }

    // ── tiles ───────────────────────────────────────────────────────────────
    function tileFor(image, index) {
        const li = el("li", "nu-gallery__cell");
        li.style.cssText = "position:relative;list-style:none;min-width:0";

        const btn = el("button", "nu-gallery__tile");
        btn.type = "button";
        btn.setAttribute("aria-label", String(image.filename || "image"));
        btn.style.cssText =
            "display:flex;flex-direction:column;gap:6px;width:100%;padding:0;border:0;" +
            "background:none;cursor:pointer;text-align:start;min-width:0";
        if (selectMode) {
            btn.setAttribute("aria-pressed", selected.has(image.path) ? "true" : "false");
        }
        if (selected.has(image.path)) btn.classList.add("nu-gallery__tile--selected");

        const box = el("div", "nu-gallery__thumb");
        box.style.cssText = TILE_BOX_CSS;
        const thumb = document.createElement("img");
        thumb.className = "nu-gallery__thumb-img";
        thumb.loading = "lazy";
        thumb.decoding = "async";
        thumb.alt = "";
        thumb.dataset.thumb = api.galleryThumbUrl(image.path, THUMB_WIDTH);
        thumb.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
        const fallback = el("span", "nu-gallery__thumb-fallback nu-hidden", "?");
        fallback.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center";
        thumb.addEventListener("error", () => {
            thumb.classList.add("nu-hidden");
            fallback.classList.remove("nu-hidden");
        });
        box.append(thumb, fallback);
        if (isVideo(image)) {
            const badge = el("span", "nu-badge nu-gallery__video-badge", "▶");
            badge.style.cssText = "position:absolute;inset-block-end:4px;inset-inline-start:4px";
            box.appendChild(badge);
        }

        const caption = el("span", "nu-gallery__tile-name", String(image.filename || ""));
        caption.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        caption.title = `${image.filename} · ${formatBytes(image.size)}`;
        btn.append(box, caption);
        btn.addEventListener("click", (event) => {
            if (selectMode) {
                toggleSelection(image, index, !!(event && event.shiftKey));
                return;
            }
            if (typeof opts.onOpen === "function") opts.onOpen(index, image);
        });

        const favBtn = createIconButton({
            icon: "★",
            ariaLabel: `${t("favorite")}: ${image.filename}`,
            title: t("favorite"),
            toggle: true,
            pressed: !!image.favorite,
            onClick: () => {
                if (typeof opts.onToggleFavorite === "function") opts.onToggleFavorite(image);
            },
        });
        favBtn.classList.add("nu-gallery__fav");
        favBtn.classList.toggle("m3-icon-btn--filled", !!image.favorite);
        favBtn.style.cssText = "position:absolute;top:4px;inset-inline-end:4px";

        li.append(btn, favBtn);
        tiles.set(image.path, { btn, favBtn, image });
        observeThumb(thumb);
        return li;
    }

    function syncTile(image) {
        const ref = tiles.get(image.path);
        if (!ref) return;
        ref.favBtn.setAttribute("aria-pressed", image.favorite ? "true" : "false");
        ref.favBtn.classList.toggle("m3-icon-btn--filled", !!image.favorite);
    }

    // ── selection ───────────────────────────────────────────────────────────
    function paintSelection() {
        for (const ref of tiles.values()) {
            const isSelected = selected.has(ref.image.path);
            ref.btn.classList.toggle("nu-gallery__tile--selected", isSelected);
            if (selectMode) ref.btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
        }
    }

    function toggleSelection(image, index, shift) {
        if (shift && lastIndex.value >= 0) {
            const from = Math.min(lastIndex.value, index);
            const to = Math.max(lastIndex.value, index);
            for (let i = from; i <= to; i++) selected.add(images[i].path);
        } else if (selected.has(image.path)) {
            selected.delete(image.path);
        } else {
            selected.add(image.path);
        }
        lastIndex.value = index;
        paintSelection();
        notify();
    }

    function setSelectMode(enabled) {
        selectMode = !!enabled;
        if (!selectMode) selected.clear();
        for (const ref of tiles.values()) {
            if (selectMode) {
                ref.btn.setAttribute("aria-pressed", selected.has(ref.image.path) ? "true" : "false");
            } else {
                ref.btn.removeAttribute("aria-pressed");
                ref.btn.classList.remove("nu-gallery__tile--selected");
            }
        }
        notify();
    }

    function destroy() {
        destroyed = true;
        if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
        if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
        tiles.clear();
        selected.clear();
        images = [];
        listEl.replaceChildren();
    }

    return {
        root,
        /** Replace the dataset and re-render from the first page. */
        setImages(nextImages, nextTotal, emptyLabel) {
            images = Array.isArray(nextImages) ? nextImages : [];
            total = Number(nextTotal) || images.length;
            tiles.clear();
            listEl.replaceChildren();
            rendered = 0;
            selected.clear();
            lastIndex.value = -1;
            emptyMsg.textContent = emptyLabel || "No images found.";
            emptyMsg.classList.toggle("nu-hidden", images.length > 0);
            appendPage();
            notify();
        },
        setSelectMode,
        isSelectMode: () => selectMode,
        getSelection: () => [...selected],
        selectAll() {
            for (const image of images) selected.add(image.path);
            lastIndex.value = images.length - 1;
            paintSelection();
            notify();
        },
        clearSelection() {
            selected.clear();
            lastIndex.value = -1;
            paintSelection();
            notify();
        },
        syncTile,
        destroy,
    };
}

export default createImageGrid;
