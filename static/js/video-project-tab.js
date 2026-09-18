/**
 * Video Tab - Sidebar "Project" subtab (next to Asset): browses saved Video
 * Plan files (ws_videoplan_*.json in video_plan/) OR saved Video Edit
 * projects (ws_videoeditproj_*.json in video_edit_project/), depending on
 * which center subtab (Plan/Edit) is currently active — video-tab.js passes
 * that mode in on every refresh (Asset stays on whichever of the two was
 * last active, since it has no saved-list concept of its own).
 *
 * Deliberately thin, mirroring video-asset-tab.js's own scope — clicking an
 * item hands off to video-plan-tab.js's openSavedVideoPlan() or
 * video-edit-tab.js's openSavedVideoEditProject() rather than
 * re-implementing plan/project loading here.
 */

import { showToast } from "./app.js";
import { t } from "./i18n.js";
import { escapeHtml } from "./util.js";
import { openSavedVideoPlan } from "./video-plan-tab.js";
import { openSavedVideoEditProject } from "./video-edit-tab.js";

// Per-mode config: which endpoints to hit, which loader/toast strings to use,
// and how to read each item's count field — keeps _renderList/_makeItem/etc.
// mode-agnostic instead of branching throughout.
const _MODES = {
    plan: {
        listUrl: "/api/wfm/video/plans",
        deleteUrl: "/api/wfm/video/plans/delete",
        open: (filename) => openSavedVideoPlan(filename),
        countOf: (item) => item.block_count ?? 0,
        countLabel: (n) => t("videoProjectBlockCount", n),
        hintKey: "videoProjectHint",
        emptyKey: "videoProjectEmpty",
        deleteConfirmKey: "videoProjectDeleteConfirm",
        deletedKey: "videoProjectDeleted",
        deleteFailedKey: "videoProjectDeleteFailed",
        loadListFailedKey: "videoProjectLoadListFailed",
    },
    edit: {
        listUrl: "/api/wfm/video/edit/projects",
        deleteUrl: "/api/wfm/video/edit/projects/delete",
        open: (filename) => openSavedVideoEditProject(filename),
        countOf: (item) => item.clip_count ?? 0,
        countLabel: (n) => t("videoEditProjectClipCount", n),
        hintKey: "videoEditProjectHint",
        emptyKey: "videoEditProjectEmpty",
        deleteConfirmKey: "videoEditProjectDeleteConfirm",
        deletedKey: "videoEditProjectDeleted",
        deleteFailedKey: "videoEditProjectDeleteFailed",
        loadListFailedKey: "videoEditProjectLoadListFailed",
    },
};

const _s = {
    mode: "plan",
    plans: [],
    activeFilename: null,
    loaded: false, // becomes true once the Project subtab has been shown at least once
};

function _formatUpdatedAt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString();
}

function _renderList() {
    const list = document.getElementById("wfm-video-project-list");
    if (!list) return;
    const cfg = _MODES[_s.mode];
    if (_s.plans.length === 0) {
        list.innerHTML = `<span class="wfm-placeholder">${t(cfg.emptyKey)}</span>`;
        return;
    }
    list.innerHTML = "";
    for (const plan of _s.plans) list.appendChild(_makeItem(plan));
}

function _makeItem(plan) {
    const cfg = _MODES[_s.mode];
    const item = document.createElement("div");
    item.className = "wfm-video-project-item" + (plan.filename === _s.activeFilename ? " active" : "");
    item.dataset.filename = plan.filename;

    const thumb = document.createElement("img");
    thumb.className = "wfm-video-project-item-thumb";
    thumb.loading = "lazy";
    if (plan.thumbnail) thumb.src = plan.thumbnail;
    thumb.onerror = () => { thumb.style.visibility = "hidden"; };

    const info = document.createElement("div");
    info.className = "wfm-video-project-item-info";

    const name = document.createElement("div");
    name.className = "wfm-video-project-item-name";
    name.textContent = plan.name || plan.filename;
    name.title = plan.filename;

    const meta = document.createElement("div");
    meta.className = "wfm-video-project-item-meta";
    const countLabel = cfg.countLabel(cfg.countOf(plan));
    const updated = _formatUpdatedAt(plan.updated_at);
    meta.textContent = updated ? `${countLabel} · ${updated}` : countLabel;
    meta.title = plan.note || "";

    info.append(name, meta);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "wfm-video-project-item-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = t("delete");
    deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _deletePlan(plan);
    });

    item.append(thumb, info, deleteBtn);
    item.addEventListener("click", () => _openPlan(plan));
    return item;
}

async function _openPlan(plan) {
    _s.activeFilename = plan.filename;
    _renderList();
    await _MODES[_s.mode].open(plan.filename);
}

async function _deletePlan(plan) {
    const cfg = _MODES[_s.mode];
    if (!window.confirm(t(cfg.deleteConfirmKey, plan.name || plan.filename))) return;
    try {
        const res = await fetch(cfg.deleteUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: plan.filename }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (_s.activeFilename === plan.filename) _s.activeFilename = null;
        showToast(t(cfg.deletedKey), "success");
        await refreshVideoProjectTab(_s.mode);
    } catch (err) {
        showToast(`${t(cfg.deleteFailedKey)}: ${err.message}`, "error");
    }
}

// Called whenever the Project subtab becomes active (see video-tab.js's prop-tab
// toggle) — always refetches rather than caching, so a plan/project saved
// elsewhere (Plan pane's Save/Save As, Edit's Save/Save As) shows up as soon
// as the user switches over to look. `mode` ("plan"|"edit") is video-tab.js's
// record of which center subtab is currently active; defaults to "plan" so
// direct calls (e.g. from initVideoProjectTab) keep the original behavior.
export async function refreshVideoProjectTab(mode = "plan") {
    const list = document.getElementById("wfm-video-project-list");
    if (!list) return;
    _s.mode = mode === "edit" ? "edit" : "plan";
    _s.activeFilename = null;
    const cfg = _MODES[_s.mode];
    const hintEl = document.getElementById("wfm-video-project-hint");
    if (hintEl) hintEl.textContent = t(cfg.hintKey);
    try {
        const res = await fetch(cfg.listUrl);
        if (!res.ok) throw new Error(String(res.status));
        _s.plans = await res.json();
        _renderList();
    } catch (err) {
        list.innerHTML = `<span class="wfm-placeholder" style="color:var(--wfm-danger)">${escapeHtml(t(cfg.loadListFailedKey))}: ${escapeHtml(err.message)}</span>`;
    }
    _s.loaded = true;
}

export function initVideoProjectTab() {
    document.getElementById("wfm-video-project-refresh")?.addEventListener("click", () => refreshVideoProjectTab());
}
