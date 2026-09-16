/**
 * Video Tab - Edit subtab: a minimal non-linear-editor-style clip timeline
 * (MVP scope: add clips, reorder, trim, concatenate, export).
 *
 * Design (see VIDEO_EDIT_TAB_PLAN.md at the repo root for the full writeup):
 *   - Every clip is uploaded to ComfyUI's `input` area on add (same
 *     upload-on-first-use pattern as video-tab.js's GIF tool), then probed
 *     via /api/wfm/video/edit/probe (PyAV, no ffmpeg) for duration/width/height.
 *   - Export builds a ComfyUI API-format prompt directly (LoadVideo -> VideoTrim
 *     per clip -> ConcatenateVideo (if >1 clip) -> SaveVideo) and runs it through
 *     the existing comfyUI.queuePrompt()/trackProgress() infra — no new backend
 *     "build workflow" endpoint needed.
 *   - Trim/scrub preview reuses the existing Source preview pane (video-preview.js)
 *     instead of a second <video> element — selecting a clip loads it there,
 *     exactly like video-asset-tab.js already does for asset selection.
 *
 * Confirmed against a live ComfyUI 0.36.0 instance (see plan doc "Phase 0"):
 *   - The class_type for the simple trim node is `"Video Slice"` (WITH A SPACE —
 *     `/object_info/VideoSlice` looks empty because that's not its real id; its
 *     node_id is literally "Video Slice"). It takes plain flat inputs
 *     (video/start_time/duration/strict_duration), no VIDEO_EDIT nesting, and
 *     is not experimental — this is what's used here, not `VideoTrim`.
 *     `VideoTrim`'s `trim` input, if ever needed, must be double-nested —
 *     `{"trim": {"start_time":.., "duration":..}}` — because its execute()
 *     does `(trim or {}).get("trim")` before reading start_time/duration; a
 *     flat `{"start_time":..}` value is silently accepted and silently
 *     no-ops (verified: it does NOT raise, it just doesn't trim anything).
 *   - `ConcatenateVideo`'s Autogrow `videos` input is addressed via flat,
 *     dot-joined keys at the top level of `inputs`: "videos.video0",
 *     "videos.video1", ... (0-indexed) — NOT a nested object and NOT plain
 *     "video0"/"video1" without the "videos." prefix.
 *   - ConcatenateVideo hard-errors at execution time if clip frame dimensions
 *     differ, so mismatched clips are blocked client-side before export.
 */

import { showToast } from "./app.js";
import { t } from "./i18n.js";
import { comfyUI } from "./comfyui-client.js";
import { setSourcePreview, setResultPreview, getActivePreviewVideoElement } from "./video-preview.js";
import { VTEMP_GROUP, ensureVideoGroup } from "./gallery-tab.js";

const _s = {
    clips: [], // { id, name, file, serverRef:{filename,subfolder,type}|null, duration, width, height, fps, trimStart, trimEnd, probing, error }
    selectedId: null,
    exporting: false,
    nextId: 1,
    outputDir: "",
};

// Pixel-per-second scale for the timeline track — clips are laid out at their
// real (trimmed) duration and left-aligned, NOT stretched to fill the track
// width like the Plan tab's blocks (whose widths are relative shares of a
// fixed-length plan) — Edit's timeline represents actual seconds.
const _PX_PER_SEC = 20;
const _MIN_BLOCK_PX = 56;

let _dragClipId = null; // clip being dragged for timeline reordering

// ============================================
// Output-dir lookup (same small helper video-asset-tab.js / video-plan-tab.js
// each keep their own copy of — needed to build the absolute path Gallery's
// group-tagging API expects).
// ============================================

async function _fetchOutputDir() {
    if (_s.outputDir) return;
    try {
        const res = await fetch("/api/wfm/settings/output-dir");
        if (res.ok) {
            const data = await res.json();
            _s.outputDir = (data.current || "").replace(/\\/g, "/").replace(/\/$/, "");
        }
    } catch { /* non-critical */ }
}

// ============================================
// Clip list state
// ============================================

function _selectedClip() {
    return _s.clips.find((c) => c.id === _s.selectedId) || null;
}

// Exported so video-asset-tab.js's "Send to Edit" button can add an asset
// (already fetched as a Blob/File the same way it feeds the Source preview)
// without either module importing the other's internals.
export function addClipFromFile(file, displayName) {
    const clip = {
        id: _s.nextId++,
        name: displayName || file.name,
        file,
        serverRef: null,
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
        trimStart: 0,
        trimEnd: 0,
        probing: true,
        error: null,
    };
    _s.clips.push(clip);
    _s.selectedId = clip.id;
    _renderTimeline();
    _renderTrimPanel();
    setSourcePreview(URL.createObjectURL(file), { kind: "local", file });
    _probeClip(clip);
}

async function _probeClip(clip) {
    try {
        const uploaded = await comfyUI.uploadImage(clip.file, clip.file.name);
        clip.serverRef = { filename: uploaded.name, subfolder: uploaded.subfolder || "", type: "input" };

        const params = new URLSearchParams({
            filename: clip.serverRef.filename,
            subfolder: clip.serverRef.subfolder,
            type: clip.serverRef.type,
        });
        const res = await fetch(`/api/wfm/video/edit/probe?${params}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

        clip.duration = json.duration || 0;
        clip.width = json.width || 0;
        clip.height = json.height || 0;
        clip.fps = json.fps || 0;
        clip.trimStart = 0;
        clip.trimEnd = clip.duration;
    } catch (err) {
        clip.error = err.message;
        showToast(t("errorWithMsg", err.message), "error");
    } finally {
        clip.probing = false;
        _renderTimeline();
        if (_s.selectedId === clip.id) _renderTrimPanel();
    }
}

function _moveClip(id, delta) {
    const idx = _s.clips.findIndex((c) => c.id === id);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= _s.clips.length) return;
    [_s.clips[idx], _s.clips[target]] = [_s.clips[target], _s.clips[idx]];
    _renderTimeline();
}

function _duplicateClip(id) {
    const idx = _s.clips.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const clone = { ..._s.clips[idx], id: _s.nextId++ };
    _s.clips.splice(idx + 1, 0, clone);
    _s.selectedId = clone.id;
    _renderTimeline();
    _renderTrimPanel();
}

function _deleteClip(id) {
    _s.clips = _s.clips.filter((c) => c.id !== id);
    if (_s.selectedId === id) {
        _s.selectedId = _s.clips.length ? _s.clips[0].id : null;
        if (_s.selectedId) _selectClip(_s.selectedId);
        else setSourcePreview(null, null);
    }
    _renderTimeline();
    _renderTrimPanel();
}

function _clearTimeline() {
    if (_s.clips.length === 0) return;
    if (!confirm(t("videoEditConfirmClear"))) return;
    _s.clips = [];
    _s.selectedId = null;
    setSourcePreview(null, null);
    _renderTimeline();
    _renderTrimPanel();
}

function _selectClip(id) {
    _s.selectedId = id;
    const clip = _selectedClip();
    _renderTimeline();
    _renderTrimPanel();
    if (clip) setSourcePreview(URL.createObjectURL(clip.file), { kind: "local", file: clip.file });
}

// ============================================
// Resolution-mismatch guard — ConcatenateVideo hard-errors at execution time
// on mismatched frame dimensions (confirmed on a live 0.36.0 instance), so
// this is checked client-side before ever building the export graph.
// ============================================

function _findResolutionMismatch(clips) {
    const sized = clips.filter((c) => c.width && c.height);
    if (sized.length < 2) return null;
    const first = sized[0];
    const mismatched = sized.find((c) => c.width !== first.width || c.height !== first.height);
    if (!mismatched) return null;
    return t("videoEditResolutionMismatch", `${first.name} (${first.width}x${first.height})`, `${mismatched.name} (${mismatched.width}x${mismatched.height})`);
}

// ============================================
// Rendering
// ============================================

function _fmtTime(s) {
    if (!s && s !== 0) return "--";
    return `${s.toFixed(1)}s`;
}

// Horizontal timeline track (see VIDEO_EDIT_TAB_PLAN.md's UI redesign note):
// clips are laid out left-to-right at their real (trimmed) duration on a
// fixed px/sec scale and left-aligned — an empty track stays empty on the
// right rather than stretching clips to fill it. Reordering is done either
// by dragging a block onto another (native HTML5 DnD) or via the shared
// toolbar buttons below the track, which act on whichever clip is selected
// (mirrors the Plan subtab's "+Split/+Block/Delete" toolbar pattern instead
// of giving every row its own set of buttons).
function _renderTimeline() {
    const track = document.getElementById("wfm-video-edit-timeline-track");
    if (!track) return;
    track.innerHTML = "";

    if (_s.clips.length === 0) {
        const placeholder = document.createElement("span");
        placeholder.className = "wfm-placeholder wfm-video-edit-timeline-placeholder";
        placeholder.textContent = t("videoEditNoClipsHint");
        track.appendChild(placeholder);
        _updateToolbarState();
        return;
    }

    _s.clips.forEach((clip) => {
        const block = document.createElement("div");
        block.className = "wfm-video-edit-timeline-block" + (clip.id === _s.selectedId ? " selected" : "");
        const seconds = clip.probing || clip.error ? 0 : Math.max(0.1, clip.trimEnd - clip.trimStart);
        block.style.width = `${Math.max(_MIN_BLOCK_PX, Math.round(seconds * _PX_PER_SEC))}px`;
        block.title = clip.name;
        block.draggable = true;

        const nameEl = document.createElement("div");
        nameEl.className = "wfm-video-edit-timeline-block-name";
        nameEl.textContent = clip.name;
        const metaEl = document.createElement("div");
        metaEl.className = "wfm-video-edit-timeline-block-meta";
        if (clip.probing) metaEl.textContent = t("videoEditProbing");
        else if (clip.error) metaEl.textContent = "✗";
        else metaEl.textContent = _fmtTime(clip.trimEnd - clip.trimStart);
        block.append(nameEl, metaEl);

        block.addEventListener("click", () => _selectClip(clip.id));

        block.addEventListener("dragstart", (e) => {
            _dragClipId = clip.id;
            e.dataTransfer.effectAllowed = "move";
        });
        block.addEventListener("dragover", (e) => e.preventDefault());
        block.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _reorderByDrop(clip.id);
        });

        track.appendChild(block);
    });

    _updateToolbarState();
}

function _reorderByDrop(targetId) {
    if (_dragClipId == null || _dragClipId === targetId) { _dragClipId = null; return; }
    const fromIdx = _s.clips.findIndex((c) => c.id === _dragClipId);
    _dragClipId = null;
    if (fromIdx < 0) return;
    // Remove first, then look up the target's index in the now-shortened array —
    // sidesteps the off-by-one from a naive "look up both indices, then splice
    // twice" approach when fromIdx < toIdx. Dropping onto a block inserts the
    // dragged clip right before it; dropping past the last block (targetId
    // null, from the track's own drop handler) appends to the end.
    const [moved] = _s.clips.splice(fromIdx, 1);
    if (targetId == null) {
        _s.clips.push(moved);
    } else {
        const toIdx = _s.clips.findIndex((c) => c.id === targetId);
        _s.clips.splice(toIdx < 0 ? _s.clips.length : toIdx, 0, moved);
    }
    _renderTimeline();
}

function _updateToolbarState() {
    const idx = _s.clips.findIndex((c) => c.id === _s.selectedId);
    const hasSelection = idx >= 0;
    const setDisabled = (id, disabled) => {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
    };
    setDisabled("wfm-video-edit-move-left-btn", !hasSelection || idx === 0);
    setDisabled("wfm-video-edit-move-right-btn", !hasSelection || idx === _s.clips.length - 1);
    setDisabled("wfm-video-edit-duplicate-btn", !hasSelection);
    setDisabled("wfm-video-edit-delete-btn", !hasSelection);
    setDisabled("wfm-video-edit-clear-btn", _s.clips.length === 0);
}

function _renderTrimPanel() {
    const panel = document.getElementById("wfm-video-edit-trim-panel");
    if (!panel) return;
    const clip = _selectedClip();
    if (!clip) {
        panel.innerHTML = `<span class="wfm-placeholder">${t("videoEditSelectClipHint")}</span>`;
        return;
    }
    if (clip.probing) {
        panel.innerHTML = `<span class="wfm-placeholder">${t("videoEditProbing")}</span>`;
        return;
    }
    if (clip.error) {
        panel.innerHTML = `<span class="wfm-placeholder" style="color:var(--wfm-danger)">✗ ${clip.error}</span>`;
        return;
    }

    // clip.name is a user-controlled filename — kept out of the innerHTML string
    // and assigned via textContent afterward (same pattern as video-asset-tab.js's
    // _renderDetail()), so it can never be interpreted as markup.
    panel.innerHTML = `
        <div class="wfm-video-edit-clip-name" id="wfm-video-edit-trim-clip-name" style="margin-bottom:6px;"></div>
        <div class="wfm-video-edit-trim-row">
            <div>
                <label>${t("videoEditTrimStart")}</label>
                <div style="display:flex;gap:4px;">
                    <input type="number" id="wfm-video-edit-trim-start" class="wfm-input" step="0.1" min="0" max="${clip.duration}" value="${clip.trimStart.toFixed(2)}">
                    <button type="button" class="wfm-btn wfm-btn-xs" id="wfm-video-edit-trim-start-set">${t("videoEditSetFromPlayhead")}</button>
                </div>
            </div>
            <div>
                <label>${t("videoEditTrimEnd")}</label>
                <div style="display:flex;gap:4px;">
                    <input type="number" id="wfm-video-edit-trim-end" class="wfm-input" step="0.1" min="0" max="${clip.duration}" value="${clip.trimEnd.toFixed(2)}">
                    <button type="button" class="wfm-btn wfm-btn-xs" id="wfm-video-edit-trim-end-set">${t("videoEditSetFromPlayhead")}</button>
                </div>
            </div>
        </div>
    `;
    const nameEl = document.getElementById("wfm-video-edit-trim-clip-name");
    if (nameEl) { nameEl.textContent = clip.name; nameEl.title = clip.name; }

    const startInput = document.getElementById("wfm-video-edit-trim-start");
    const endInput = document.getElementById("wfm-video-edit-trim-end");

    const commit = () => {
        let start = Math.max(0, Math.min(Number(startInput.value) || 0, clip.duration));
        let end = Math.max(0, Math.min(Number(endInput.value) || 0, clip.duration));
        if (end <= start) end = Math.min(clip.duration, start + 0.1);
        clip.trimStart = start;
        clip.trimEnd = end;
        startInput.value = start.toFixed(2);
        endInput.value = end.toFixed(2);
        _renderTimeline();
    };
    startInput.addEventListener("change", commit);
    endInput.addEventListener("change", commit);

    document.getElementById("wfm-video-edit-trim-start-set")?.addEventListener("click", () => {
        const video = getActivePreviewVideoElement();
        if (video) { startInput.value = video.currentTime.toFixed(2); commit(); }
    });
    document.getElementById("wfm-video-edit-trim-end-set")?.addEventListener("click", () => {
        const video = getActivePreviewVideoElement();
        if (video) { endInput.value = video.currentTime.toFixed(2); commit(); }
    });
}

// ============================================
// Export — builds a ComfyUI API-format prompt directly (see module header for
// the confirmed input formats) and runs it through the existing execution
// infrastructure (comfyui-client.js), exactly like video-plan-tab.js does.
// ============================================

function _buildExportWorkflow(clips) {
    const prompt = {};
    let nextId = 1;
    const alloc = () => String(nextId++);
    const trimOutputs = [];

    for (const clip of clips) {
        const loadId = alloc();
        const file = clip.serverRef.subfolder
            ? `${clip.serverRef.subfolder}/${clip.serverRef.filename}`
            : clip.serverRef.filename;
        prompt[loadId] = { class_type: "LoadVideo", inputs: { file } };

        const trimId = alloc();
        prompt[trimId] = {
            class_type: "Video Slice",
            inputs: {
                video: [loadId, 0],
                start_time: clip.trimStart,
                duration: Math.max(0.05, clip.trimEnd - clip.trimStart),
                strict_duration: false,
            },
        };
        trimOutputs.push(trimId);
    }

    let finalOutput;
    if (trimOutputs.length === 1) {
        finalOutput = [trimOutputs[0], 0];
    } else {
        const concatId = alloc();
        const inputs = { codec: "auto" };
        // Autogrow's flat "videos.videoN" key format — see module header.
        trimOutputs.forEach((tid, i) => { inputs[`videos.video${i}`] = [tid, 0]; });
        prompt[concatId] = { class_type: "ConcatenateVideo", inputs };
        finalOutput = [concatId, 0];
    }

    const saveId = alloc();
    prompt[saveId] = {
        class_type: "SaveVideo",
        inputs: { video: finalOutput, filename_prefix: "video/wfm_edit", format: "auto" },
    };
    return { prompt, saveId };
}

function _setExportUi(running, pct) {
    const btn = document.getElementById("wfm-video-edit-export-btn");
    const bar = document.getElementById("wfm-video-edit-progress-bar");
    const text = document.getElementById("wfm-video-edit-progress-text");
    if (btn) btn.disabled = running;
    if (bar) bar.style.width = `${Math.round((pct || 0) * 100)}%`;
    if (text) text.textContent = running ? t("videoEditExporting") : "Ready";
}

async function _addOutputToVideoTemp(filename, subfolder) {
    await _fetchOutputDir();
    if (!_s.outputDir) return;
    const parts = [_s.outputDir];
    if (subfolder) parts.push(subfolder);
    parts.push(filename);
    const path = parts.join("/");
    try {
        await ensureVideoGroup();
        await fetch(`/wfm/gallery/groups/${encodeURIComponent(VTEMP_GROUP)}/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
    } catch (err) {
        console.warn("[VideoEdit] failed to tag export into video group:", err);
    }
}

async function _exportTimeline() {
    if (_s.exporting) return;

    const readyClips = _s.clips.filter((c) => c.serverRef && !c.error);
    if (readyClips.length === 0) {
        showToast(t("videoEditNoClips"), "error");
        return;
    }
    if (_s.clips.some((c) => c.probing)) {
        showToast(t("videoEditStillProbing"), "error");
        return;
    }
    const mismatch = _findResolutionMismatch(readyClips);
    if (mismatch) {
        showToast(mismatch, "error");
        return;
    }

    _s.exporting = true;
    _setExportUi(true, 0);
    try {
        const wsOk = await comfyUI.connectWebSocket();
        if (!wsOk) throw new Error("Failed to connect WebSocket");

        const { prompt, saveId } = _buildExportWorkflow(readyClips);
        const result = await comfyUI.queuePrompt(prompt);
        await comfyUI.trackProgress(result.prompt_id, (pct) => _setExportUi(true, pct));

        const history = await comfyUI.getHistory(result.prompt_id);
        const output = history?.outputs?.[saveId]?.images?.[0];
        if (!output) throw new Error("No output produced");

        const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || "", type: "output" });
        setResultPreview(`${comfyUI.baseUrl}/view?${params}`, { kind: "output", filename: output.filename, subfolder: output.subfolder || "", type: "output" });
        showToast(t("videoEditExportDone", output.filename), "success");
        await _addOutputToVideoTemp(output.filename, output.subfolder);
    } catch (err) {
        showToast(t("errorWithMsg", err.message), "error");
    } finally {
        _s.exporting = false;
        _setExportUi(false, 0);
    }
}

// ============================================
// Init
// ============================================

function _wireAddClipDropZone() {
    const dropZone = document.getElementById("wfm-video-edit-drop-zone");
    const fileInput = document.getElementById("wfm-video-edit-file-input");
    if (!dropZone || !fileInput) return;

    const addFiles = (files) => {
        for (const file of files) {
            if (!file.type.startsWith("video/")) continue;
            addClipFromFile(file);
        }
    };

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) addFiles(Array.from(fileInput.files));
        fileInput.value = "";
    });
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        if (e.dataTransfer.files.length > 0) addFiles(Array.from(e.dataTransfer.files));
    });
}

function _wireToolbar() {
    document.getElementById("wfm-video-edit-move-left-btn")?.addEventListener("click", () => {
        if (_s.selectedId != null) _moveClip(_s.selectedId, -1);
    });
    document.getElementById("wfm-video-edit-move-right-btn")?.addEventListener("click", () => {
        if (_s.selectedId != null) _moveClip(_s.selectedId, 1);
    });
    document.getElementById("wfm-video-edit-duplicate-btn")?.addEventListener("click", () => {
        if (_s.selectedId != null) _duplicateClip(_s.selectedId);
    });
    document.getElementById("wfm-video-edit-delete-btn")?.addEventListener("click", () => {
        if (_s.selectedId != null) _deleteClip(_s.selectedId);
    });
    document.getElementById("wfm-video-edit-clear-btn")?.addEventListener("click", _clearTimeline);

    // Dropping a dragged block past the last one (onto empty track space)
    // moves it to the end — block-level drop handlers stopPropagation() so
    // this only fires for drops that miss every block.
    const track = document.getElementById("wfm-video-edit-timeline-track");
    track?.addEventListener("dragover", (e) => e.preventDefault());
    track?.addEventListener("drop", (e) => {
        e.preventDefault();
        _reorderByDrop(null);
    });
}

export function initVideoEditTab() {
    _wireAddClipDropZone();
    _wireToolbar();
    document.getElementById("wfm-video-edit-export-btn")?.addEventListener("click", _exportTimeline);
    _renderTimeline();
    _renderTrimPanel();
}
