/**
 * views/gallery.js — the output browser (brief §5, parity table item 9).
 *
 *   folder tree   ← api.listGalleryFolders(root); root comes from api.getOutputDir()
 *   image grid    ← api.listGalleryImages({folder, search, sort, favorite, tag, group, recursive})
 *                   thumbnails: api.galleryThumbUrl (lazy + IntersectionObserver),
 *                   large view:  api.galleryServeUrl
 *   per image     → views/gallery/preview.js (favourite, memo/tags, workflow restore)
 *   groups        → views/gallery/groups.js
 *   bulk actions  → api.bulkGalleryFavorite / api.bulkGalleryGroup /
 *                   api.deleteGalleryImages (single output → api.deleteOutputImage)
 *
 * Incremental loading: the grid renders PAGE_SIZE tiles at a time and appends the next
 * page when the sentinel scrolls into view or the "Load more" button is pressed, so a
 * folder with 1000+ images never blocks input.
 *
 * Prefs: `nu_gallery_sort`, `nu_gallery_root` (never the old `wfm_gallery_*` keys).
 * Store handoff (see views/gallery/preview.js):
 *   ctx.store.setState({ workflow, workflowName, workflowSource: "gallery" })
 */

import { api, t, readPref, writePref } from "../../core/index.js";
import { createButton } from "../components/Button.js";
import { createIconButton } from "../components/IconButton.js";
import { createTextField } from "../components/TextField.js";
import { createSelect } from "../components/Select.js";
import { createChip } from "../components/Chip.js";
import { createLinearProgress } from "../components/Progress.js";
import { openMenu } from "../components/Menu.js";
import { confirm } from "../dialog.js";
import { showSnackbar } from "../snackbar.js";
import { initRipple } from "../ripple.js";
import { openImageViewer } from "./gallery/preview.js";
import { createGroupsController } from "./gallery/groups.js";

const PAGE_SIZE = 60;
const THUMB_WIDTH = 256;
const SEARCH_DEBOUNCE_MS = 300;

/** Mirrors gallery_service.list_images — any other value falls back to date_desc. */
const SORT_OPTIONS = [
    { value: "date_desc", label: "Newest first" },
    { value: "date_asc", label: "Oldest first" },
    { value: "name_asc", label: "Name A → Z" },
    { value: "name_desc", label: "Name Z → A" },
];

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

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {HTMLElement} container
 * @param {{store?:object, navigate?:Function}} ctx
 * @returns {{destroy:()=>void, refresh:()=>Promise<void>}}
 */
export function render(container, ctx) {
    container.replaceChildren();

    const state = {
        root: String(readPref("gallery_root", "") || ""),
        currentFolder: "",
        tree: null,
        expanded: new Set(),
        images: [],
        total: 0,
        allTags: new Set(),
        selected: new Set(),
        lastIndex: -1,
        rendered: 0,
        selectMode: false,
        sort: String(readPref("gallery_sort", "date_desc") || "date_desc"),
        search: "",
        favoriteOnly: false,
        tagFilter: "",
        groupFilter: "",
        destroyed: false,
    };
    let imagesAbort = null;
    let searchTimer = null;
    let thumbObserver = null;
    let sentinelObserver = null;
    let sentinelEl = null;
    let syncingChip = false;
    const tileRefs = new Map();

    const groups = createGroupsController({
        onChanged: (list) => {
            const current = state.groupFilter;
            groupSelect.setOptions([
                { value: "", label: t("allGroups") },
                ...list.map((name) => ({ value: name, label: name })),
            ]);
            if (current && !list.includes(current)) {
                state.groupFilter = "";
                groupSelect.setValue("");
            } else if (current) {
                groupSelect.setValue(current);
            }
        },
    });

    // ── header ──────────────────────────────────────────────────────────────
    const view = el("section", "nu-view nu-gallery");
    const header = el("header", "nu-view__header");
    const heading = el("div", "nu-stack");
    heading.append(el("h1", "nu-view__title", t("tabGallery")), el("p", "nu-view__subtitle nu-muted", "Output images, metadata and embedded workflows."));
    const note = el("p", "nu-muted", "");
    heading.appendChild(note);

    const headerTools = el("div", "nu-view__toolbar");
    const rootField = createTextField({ label: "Gallery root", placeholder: "/path/to/ComfyUI/output" });
    rootField.root.style.flex = "1 1 260px";
    const rootApplyBtn = createButton({
        label: "Use root",
        variant: "outlined",
        onClick: () => applyRoot(rootField.getValue()),
    });
    const refreshBtn = createIconButton({
        icon: "⟳",
        ariaLabel: t("refresh"),
        title: t("refresh"),
        onClick: () => refreshAll(),
    });
    const groupsBtn = createButton({
        label: "Groups",
        variant: "tonal",
        onClick: () => groups.openManager([...state.selected]),
    });
    const selectChip = createChip({
        label: "Select",
        variant: "filter",
        selected: false,
        onToggle: (selected) => {
            if (syncingChip) return;
            setSelectMode(!!selected);
        },
    });
    headerTools.append(rootField.root, rootApplyBtn, refreshBtn, groupsBtn, selectChip.root);
    header.append(heading, headerTools);

    // ── body: tree | grid ───────────────────────────────────────────────────
    const body = el("div", "nu-view__body nu-gallery__body");
    body.style.cssText =
        "display:grid;grid-template-columns:minmax(200px,280px) minmax(0,1fr);gap:16px;align-items:start";

    const sidebar = el("div", "nu-gallery__sidebar");
    sidebar.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0";
    const treeTitle = el("p", "nu-field__label", "Folders");
    const tree = el("ul", "nu-gallery__tree");
    tree.style.cssText = "list-style:none;margin:0;padding:0;max-height:64vh;overflow:auto";
    sidebar.append(treeTitle, tree);

    const main = el("div", "nu-gallery__main");
    main.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:0";
    const progress = createLinearProgress({ indeterminate: true, ariaLabel: t("loading") });
    progress.root.classList.add("nu-hidden");

    const controls = el("div", "nu-view__toolbar");
    const searchField = createTextField({
        label: "Search images",
        placeholder: t("searchPlaceholder"),
        onInput: (value) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.search = String(value || "");
                loadImages();
            }, SEARCH_DEBOUNCE_MS);
        },
    });
    searchField.root.style.flex = "1 1 200px";
    const sortSelect = createSelect({
        label: "Sort",
        options: SORT_OPTIONS,
        value: state.sort,
        onChange: (value) => {
            state.sort = value || "date_desc";
            writePref("gallery_sort", state.sort);
            loadImages();
        },
    });
    const favChip = createChip({
        label: t("favorite"),
        variant: "filter",
        selected: false,
        onToggle: (selected) => {
            state.favoriteOnly = !!selected;
            loadImages();
        },
    });
    const groupSelect = createSelect({
        label: "Group",
        options: [{ value: "", label: t("allGroups") }],
        value: "",
        onChange: (value) => {
            state.groupFilter = value || "";
            loadImages();
        },
    });
    controls.append(searchField.root, sortSelect.root, groupSelect.root, favChip.root);

    const tagRow = el("div", "nu-row nu-gallery__tags");
    const bulkBar = el("div", "m3-card nu-gallery__bulk");
    bulkBar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px";
    bulkBar.classList.add("nu-hidden");
    const bulkLabel = el("span", "nu-gallery__bulk-label", "");
    const bulkFavBtn = createButton({ label: "Favorite", variant: "text", onClick: () => bulkFavorite(true) });
    const bulkUnfavBtn = createButton({ label: "Unfavorite", variant: "text", onClick: () => bulkFavorite(false) });
    const bulkAddBtn = createButton({ label: "Add to group", variant: "text", onClick: (e) => openGroupMenu(e.currentTarget, "add") });
    const bulkRemoveBtn = createButton({ label: "Remove from group", variant: "text", onClick: (e) => openGroupMenu(e.currentTarget, "remove") });
    const bulkAllBtn = createButton({ label: "Select all", variant: "text", onClick: () => selectAll() });
    const bulkClearBtn = createButton({ label: "Clear", variant: "text", onClick: () => clearSelection() });
    const bulkDeleteBtn = createButton({ label: t("delete"), variant: "outlined", onClick: () => bulkDelete() });
    const bulkDoneBtn = createButton({ label: "Done", variant: "filled", onClick: () => setSelectMode(false) });
    bulkBar.append(bulkLabel, bulkFavBtn, bulkUnfavBtn, bulkAddBtn, bulkRemoveBtn, bulkAllBtn, bulkClearBtn, bulkDeleteBtn, bulkDoneBtn);

    const grid = el("ul", "nu-gallery__grid");
    grid.setAttribute("aria-label", "Gallery images");
    grid.style.cssText =
        "list-style:none;margin:0;padding:0;display:grid;" +
        "grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px";
    const empty = el("p", "nu-empty nu-hidden", "No images found.");
    const moreRow = el("div", "nu-row");
    const moreBtn = createButton({ label: "Load more", variant: "tonal", onClick: () => appendPage() });
    moreBtn.classList.add("nu-hidden");
    const statusLabel = el("p", "nu-muted", "");
    moreRow.append(moreBtn, el("span", "nu-spacer"), statusLabel);
    main.append(progress.root, controls, tagRow, bulkBar, grid, empty, moreRow);
    body.append(sidebar, main);
    view.append(header, body);
    container.appendChild(view);

    // ── thumbnail lazy loading ──────────────────────────────────────────────
    function observeThumb(thumb) {
        if (typeof IntersectionObserver !== "function") {
            thumb.src = thumb.dataset.thumb || "";
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

    // ── tree ────────────────────────────────────────────────────────────────
    function renderTree() {
        tree.replaceChildren();
        if (!state.tree) {
            tree.appendChild(el("li", "nu-empty", t("loading")));
            return;
        }
        tree.appendChild(treeNode(state.tree, 0, true));
    }

    function treeNode(node, depth, isRoot) {
        const li = el("li");
        const row = el("div", "nu-gallery__tree-row");
        row.style.cssText = `display:flex;align-items:center;gap:2px;padding-inline-start:${depth * 12}px`;
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const expanded = state.expanded.has(node.abs_path);
        const name = isRoot ? "[root]" : String(node.name || "");
        const toggle = createIconButton({
            icon: expanded ? "▾" : "▸",
            ariaLabel: `${expanded ? "Collapse" : "Expand"} ${name}`,
            title: hasChildren ? "Expand / collapse" : "No subfolders",
            disabled: !hasChildren,
            onClick: () => {
                if (expanded) state.expanded.delete(node.abs_path);
                else state.expanded.add(node.abs_path);
                renderTree();
            },
        });
        const label = el("button", "nu-gallery__tree-label");
        label.type = "button";
        label.style.cssText =
            "flex:1 1 auto;display:flex;align-items:center;gap:6px;text-align:start;" +
            "background:none;border:0;padding:4px 6px;cursor:pointer;min-width:0";
        label.append(el("span", "nu-gallery__tree-name", name));
        if (node.image_count > 0) label.appendChild(el("span", "nu-badge", String(node.image_count)));
        if (state.currentFolder === node.abs_path) {
            li.classList.add("nu-gallery__tree-item--selected");
            label.setAttribute("aria-current", "true");
        }
        label.addEventListener("click", () => selectFolder(node.abs_path, isRoot));
        row.append(toggle, label);
        li.appendChild(row);
        if (hasChildren && expanded) {
            const sub = el("ul", "nu-gallery__tree-children");
            sub.style.cssText = "list-style:none;margin:0;padding:0";
            for (const child of node.children) sub.appendChild(treeNode(child, depth + 1, false));
            li.appendChild(sub);
        }
        return li;
    }

    async function loadTree() {
        if (!state.root) {
            state.tree = null;
            renderTree();
            return;
        }
        progress.root.classList.remove("nu-hidden");
        try {
            const data = await api.listGalleryFolders(state.root);
            if (state.destroyed) return;
            if (data && data.error) {
                state.tree = null;
                showSnackbar({ label: t("errorWithMsg", data.error), timeout: 6000 });
            } else {
                state.tree = data || null;
                if (state.tree && state.tree.abs_path) state.expanded.add(state.tree.abs_path);
            }
        } catch (e) {
            state.tree = null;
            if (!state.destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        } finally {
            progress.root.classList.add("nu-hidden");
        }
        if (state.destroyed) return;
        renderTree();
        if (state.tree && !state.currentFolder) selectFolder(state.tree.abs_path, true);
    }

    function selectFolder(absPath, isRoot) {
        state.currentFolder = absPath || "";
        state.selected.clear();
        state.allTags.clear();
        updateBulkBar();
        renderTree();
        if (isRoot && state.tree) state.expanded.add(state.tree.abs_path);
        loadImages();
    }

    /** Pick a new gallery root (listGalleryFolders also configures it server-side). */
    async function applyRoot(nextRoot) {
        const value = String(nextRoot || "").trim();
        if (!value) { showSnackbar({ label: "Enter an output directory", timeout: 4000 }); return; }
        state.root = value;
        state.currentFolder = "";
        state.expanded.clear();
        writePref("gallery_root", value);
        await loadTree(); // selects the root folder, which loads its images
    }

    // ── images ──────────────────────────────────────────────────────────────
    async function loadImages() {
        if (!state.currentFolder) {
            state.images = [];
            state.total = 0;
            renderGrid();
            return;
        }
        if (imagesAbort) imagesAbort.abort();
        const controller = new AbortController();
        imagesAbort = controller;
        progress.root.classList.remove("nu-hidden");

        const params = { folder: state.currentFolder, sort: state.sort, signal: controller.signal };
        if (state.search) params.search = state.search;
        if (state.favoriteOnly) params.favorite = "true";
        if (state.tagFilter) params.tag = state.tagFilter;
        if (state.groupFilter) {
            params.group = state.groupFilter;
            params.recursive = "true";
        }
        try {
            const data = await api.listGalleryImages(params);
            if (state.destroyed || controller.signal.aborted) return;
            state.images = Array.isArray(data && data.images) ? data.images : [];
            state.total = Number(data && data.total) || state.images.length;
            state.lastIndex = -1;
            for (const image of state.images) {
                for (const tag of image.tags || []) state.allTags.add(String(tag));
            }
            renderGrid();
            renderTagChips();
        } catch (e) {
            if (e && e.name === "AbortError") return;
            state.images = [];
            state.total = 0;
            if (!state.destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
            renderGrid();
        } finally {
            if (imagesAbort === controller) {
                imagesAbort = null;
                progress.root.classList.add("nu-hidden");
            }
        }
    }

    function renderTagChips() {
        tagRow.replaceChildren();
        const tags = [...state.allTags].sort((a, b) => a.localeCompare(b)).slice(0, 16);
        if (tags.length === 0) return;
        tagRow.appendChild(el("span", "nu-field__label", t("tags")));
        const allChip = createChip({
            label: "All",
            variant: "filter",
            selected: !state.tagFilter,
            onToggle: () => { state.tagFilter = ""; loadImages(); },
        });
        tagRow.appendChild(allChip.root);
        for (const tag of tags) {
            const chip = createChip({
                label: tag,
                variant: "filter",
                selected: state.tagFilter === tag,
                onToggle: (selected) => {
                    state.tagFilter = selected ? tag : "";
                    loadImages();
                },
            });
            tagRow.appendChild(chip.root);
        }
    }

    function renderGrid() {
        // The sentinel element survives a re-render; it is re-attached after the tiles.
        tileRefs.clear();
        grid.replaceChildren();
        state.rendered = 0;
        empty.classList.toggle("nu-hidden", state.images.length > 0);
        empty.textContent = state.search || state.tagFilter || state.groupFilter
            ? "No images match the current filters."
            : "No images found.";
        appendPage();
    }

    /** Invisible row at the end of the grid that pulls in the next page. */
    function ensureSentinel() {
        if (sentinelEl) return;
        sentinelEl = el("li", "nu-gallery__sentinel");
        sentinelEl.dataset.sentinel = "true";
        sentinelEl.style.cssText = "grid-column:1/-1;height:1px;list-style:none";
        sentinelObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) appendPage();
            },
            { rootMargin: "300px" },
        );
        sentinelObserver.observe(sentinelEl);
    }

    function appendPage() {
        const end = Math.min(state.rendered + PAGE_SIZE, state.images.length);
        const fragment = document.createDocumentFragment();
        for (let i = state.rendered; i < end; i++) fragment.appendChild(tileFor(state.images[i], i));
        grid.appendChild(fragment);
        state.rendered = end;
        const remaining = state.images.length - state.rendered;
        moreBtn.classList.toggle("nu-hidden", remaining <= 0);
        statusLabel.textContent = state.images.length
            ? `${state.rendered} / ${state.images.length} loaded (${state.total} total)`
            : state.total ? `${state.total} total` : "";
        if (remaining > 0) {
            ensureSentinel();
            grid.appendChild(sentinelEl); // keep it last so the observer fires again
        } else if (sentinelEl) {
            sentinelEl.remove();
        }
    }

    function tileFor(image, index) {
        const li = el("li", "nu-gallery__cell");
        li.style.cssText = "position:relative;list-style:none;min-width:0";
        const btn = el("button", "nu-gallery__tile");
        btn.type = "button";
        btn.setAttribute("aria-label", String(image.filename || "image"));
        btn.style.cssText =
            "display:flex;flex-direction:column;gap:6px;width:100%;padding:0;border:0;" +
            "background:none;cursor:pointer;text-align:start;min-width:0";
        if (state.selectMode) {
            btn.setAttribute("aria-pressed", state.selected.has(image.path) ? "true" : "false");
        }
        if (state.selected.has(image.path)) btn.classList.add("nu-gallery__tile--selected");

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
        btn.addEventListener("click", (event) => onTileClick(index, event));

        const favBtn = createIconButton({
            icon: "★",
            ariaLabel: `${t("favorite")}: ${image.filename}`,
            title: t("favorite"),
            toggle: true,
            pressed: !!image.favorite,
            onClick: () => toggleFavorite(image),
        });
        favBtn.classList.add("nu-gallery__fav");
        favBtn.classList.toggle("m3-icon-btn--filled", !!image.favorite);
        favBtn.style.cssText = "position:absolute;top:4px;inset-inline-end:4px";

        li.append(btn, favBtn);
        tileRefs.set(image.path, { btn, favBtn, image });
        observeThumb(thumb);
        return li;
    }

    function onTileClick(index, event) {
        const image = state.images[index];
        if (!image) return;
        if (state.selectMode) {
            toggleSelection(image, index, !!(event && event.shiftKey));
            return;
        }
        openImageViewer({
            images: state.images,
            index,
            ctx,
            onChanged: (changed) => syncTile(changed),
        });
    }

    function syncTile(image) {
        const ref = tileRefs.get(image.path);
        if (!ref) return;
        ref.favBtn.setAttribute("aria-pressed", image.favorite ? "true" : "false");
        ref.favBtn.classList.toggle("m3-icon-btn--filled", !!image.favorite);
    }

    async function toggleFavorite(image) {
        try {
            const res = await api.toggleGalleryFavorite(image.path);
            image.favorite = res && typeof res.favorite === "boolean" ? res.favorite : !image.favorite;
            syncTile(image);
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    // ── selection & bulk actions ────────────────────────────────────────────
    function setSelectMode(enabled) {
        state.selectMode = !!enabled;
        syncingChip = true;
        selectChip.setSelected(state.selectMode);
        syncingChip = false;
        bulkBar.classList.toggle("nu-hidden", !state.selectMode);
        if (!state.selectMode) state.selected.clear();
        for (const ref of tileRefs.values()) {
            if (state.selectMode) {
                ref.btn.setAttribute("aria-pressed", state.selected.has(ref.image.path) ? "true" : "false");
            } else {
                ref.btn.removeAttribute("aria-pressed");
                ref.btn.classList.remove("nu-gallery__tile--selected");
            }
        }
        updateBulkBar();
    }

    function toggleSelection(image, index, shift) {
        if (shift && state.lastIndex >= 0) {
            const from = Math.min(state.lastIndex, index);
            const to = Math.max(state.lastIndex, index);
            for (let i = from; i <= to; i++) state.selected.add(state.images[i].path);
        } else if (state.selected.has(image.path)) {
            state.selected.delete(image.path);
        } else {
            state.selected.add(image.path);
        }
        state.lastIndex = index;
        applySelection();
        updateBulkBar();
    }

    function applySelection() {
        for (const ref of tileRefs.values()) {
            const isSelected = state.selected.has(ref.image.path);
            ref.btn.classList.toggle("nu-gallery__tile--selected", isSelected);
            if (state.selectMode) ref.btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
        }
    }

    function selectAll() {
        for (const image of state.images) state.selected.add(image.path);
        state.lastIndex = state.images.length - 1;
        applySelection();
        updateBulkBar();
    }

    function clearSelection() {
        state.selected.clear();
        state.lastIndex = -1;
        applySelection();
        updateBulkBar();
    }

    function updateBulkBar() {
        bulkLabel.textContent = `${state.selected.size} selected`;
        const none = state.selected.size === 0;
        for (const btn of [bulkFavBtn, bulkUnfavBtn, bulkAddBtn, bulkRemoveBtn, bulkDeleteBtn]) btn.disabled = none;
        bulkAllBtn.disabled = state.images.length === 0 || state.selected.size === state.images.length;
    }

    async function bulkFavorite(value) {
        const paths = [...state.selected];
        if (paths.length === 0) return;
        try {
            const res = await api.bulkGalleryFavorite(paths, value);
            const count = res && typeof res.ok === "number" ? res.ok : paths.length;
            for (const path of paths) {
                const ref = tileRefs.get(path);
                if (ref) { ref.image.favorite = value; syncTile(ref.image); }
            }
            showSnackbar({
                label: value ? t("favoritedNImages", count) : t("unfavoritedNImages", count),
                timeout: 3500,
            });
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    /** {filename, subfolder, type:"output"} for api.deleteOutputImage, or null. */
    function outputRef(path) {
        const norm = String(path || "").replace(/\\/g, "/");
        const cut = norm.lastIndexOf("/");
        const filename = cut >= 0 ? norm.slice(cut + 1) : norm;
        if (!filename) return null;
        let dir = cut >= 0 ? norm.slice(0, cut) : "";
        const rootNorm = String(state.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
        if (rootNorm && dir.startsWith(rootNorm)) dir = dir.slice(rootNorm.length);
        dir = dir.replace(/^\/+|\/+$/g, "");
        return { filename, subfolder: dir, type: "output" };
    }

    async function bulkDelete() {
        const paths = [...state.selected];
        if (paths.length === 0) return;
        const ok = await confirm({
            title: t("delete"),
            content: paths.length === 1
                ? `Delete "${paths[0].split("/").pop()}"?`
                : `Delete ${paths.length} images? This cannot be undone.`,
            confirmLabel: t("delete"),
            danger: true,
        });
        if (!ok) return;
        try {
            if (paths.length === 1) {
                const ref = outputRef(paths[0]);
                if (ref) await api.deleteOutputImage(ref);
                else await api.deleteGalleryImages(paths);
            } else {
                const res = await api.deleteGalleryImages(paths);
                const failed = res && Array.isArray(res.errors) ? res.errors.length : 0;
                if (failed) showSnackbar({ label: `${failed} file(s) could not be deleted`, timeout: 6000 });
            }
            showSnackbar({ label: t("deletedNImages", paths.length), timeout: 3500 });
            clearSelection();
            await loadImages();
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    function openGroupMenu(anchor, action) {
        const items = groups.getGroups().map((name) => ({ label: name, value: name }));
        items.push({ separator: true });
        items.push({ label: "New group…", value: "__new__" });
        openMenu({
            anchor,
            items,
            ariaLabel: action === "add" ? "Add to group" : "Remove from group",
            onSelect: async (choice) => {
                const value = choice && typeof choice === "object" ? choice.value : choice;
                if (!value) return;
                if (value === "__new__") {
                    const created = await groups.create();
                    if (created) await groups.addPaths([...state.selected], created);
                    return;
                }
                if (action === "add") await groups.addPaths([...state.selected], value);
                else await groups.removePaths([...state.selected], value);
                if (state.groupFilter) await loadImages();
            },
        });
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    async function refreshAll() {
        await loadTree();
        await loadImages();
    }

    async function init() {
        try {
            const info = await api.getOutputDir();
            const serverRoot = String((info && (info.current || info.default)) || "");
            note.textContent = serverRoot ? `Backend output dir: ${serverRoot}` : "Set an output directory in Settings.";
            if (!state.root) state.root = serverRoot;
        } catch (e) {
            if (!state.destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
        if (state.destroyed) return;
        rootField.setValue(state.root);
        await loadTree(); // selects the root folder, which loads its images
        groups.refresh();
    }

    function destroy() {
        state.destroyed = true;
        clearTimeout(searchTimer);
        if (imagesAbort) imagesAbort.abort();
        if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
        if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
        tileRefs.clear();
        groups.destroy();
    }

    renderGrid();
    init();
    initRipple(view);

    return { destroy, refresh: refreshAll };
}

export default render;
