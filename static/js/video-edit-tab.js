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
 *     differ, so mismatched clips are blocked client-side before export —
 *     but only between VIDEO clips; an image clip is auto-fit (ImageScale,
 *     center-crop) to match, since it isn't fixed-resolution source footage.
 *
 * Image clips: a still or animated image dropped in has no inherent video
 * duration, so it gets a user-editable "hold" length instead of in/out trim
 * points (clip.trimStart stays 0, clip.trimEnd IS the hold length — this
 * keeps it a drop-in replacement everywhere the code already reads
 * trimEnd-trimStart as "this clip's length in the timeline", e.g. the block
 * width calc and the total-duration readout). Export turns it into a real
 * VIDEO segment via LoadImage -> (ImageScale, only if resolution needs to
 * match) -> RepeatImageBatch(amount = holdSeconds * fps) -> CreateVideo —
 * confirmed on a live instance to produce an exact-duration, correctly
 * concatenation-compatible clip (see VIDEO_EDIT_TAB_PLAN.md "Image clips").
 */

import { showToast } from "./app.js";
import { t } from "./i18n.js";
import { comfyUI } from "./comfyui-client.js";
import {
    setSourcePreview, setResultPreview, getActivePreviewVideoElement, getResultPreviewVideoElement,
} from "./video-preview.js";
import { VTEMP_GROUP, ensureVideoGroup } from "./gallery-tab.js";

const _s = {
    clips: [], // { id, name, file, kind:"video"|"image", serverRef:{filename,subfolder,type}|null, duration, width, height, fps, trimStart, trimEnd, probing, error }
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

// Default hold length for a freshly-added image clip; user-adjustable per
// clip afterward in the trim panel.
const _DEFAULT_IMAGE_DURATION = 3.0;
// fps used when turning a held image into a video segment for export/preview
// concatenation — arbitrary but consistent (doesn't need to match other
// clips' native fps; ConcatenateVideo works at the container/frame level).
const _IMAGE_EXPORT_FPS = 24;

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
    const kind = file.type.startsWith("video/") ? "video" : "image";
    const clip = {
        id: _s.nextId++,
        name: displayName || file.name,
        file,
        kind,
        serverRef: null,
        duration: kind === "image" ? _DEFAULT_IMAGE_DURATION : 0,
        width: 0,
        height: 0,
        fps: 0,
        trimStart: 0,
        trimEnd: kind === "image" ? _DEFAULT_IMAGE_DURATION : 0,
        probing: true,
        error: null,
    };
    _s.clips.push(clip);
    _s.selectedId = clip.id;
    _renderTimeline();
    _renderTrimPanel();
    setSourcePreview(URL.createObjectURL(file), { kind: "local", file }, kind);
    if (kind === "image") _probeImageClip(clip);
    else _probeClip(clip);
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

// Image dimensions are read client-side (no server round-trip needed — PyAV
// isn't reliable for opening arbitrary still-image formats as "video" the
// way it is for real video containers) via a throwaway <img>, revoking its
// blob URL once read either way.
function _readImageDimensions(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to read image dimensions")); };
        img.src = url;
    });
}

async function _probeImageClip(clip) {
    try {
        const uploaded = await comfyUI.uploadImage(clip.file, clip.file.name);
        clip.serverRef = { filename: uploaded.name, subfolder: uploaded.subfolder || "", type: "input" };
        const dims = await _readImageDimensions(clip.file);
        clip.width = dims.width;
        clip.height = dims.height;
        // duration/trimEnd already hold the default (or a previously-edited)
        // hold length — probing an image only needs to fill in serverRef/size.
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
    _stopPreview();
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
    _stopPreview();
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
    if (clip) setSourcePreview(URL.createObjectURL(clip.file), { kind: "local", file: clip.file }, clip.kind);
}

// ============================================
// Resolution-mismatch guard — ConcatenateVideo hard-errors at execution time
// on mismatched frame dimensions (confirmed on a live 0.36.0 instance), so
// this is checked client-side before ever building the export graph. Only
// VIDEO clips are compared: an image clip's resolution is auto-fit at export
// time (see _buildExportWorkflow), so it can never be the thing blocking export.
// ============================================

function _findResolutionMismatch(clips) {
    const sized = clips.filter((c) => c.kind === "video" && c.width && c.height);
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

// M:SS.ds timecode for the trim scrubber's ruler ticks and badges (mirrors
// the "0:01.70" style Clipchamp-like editors use) — distinct from _fmtTime's
// coarser "1.7s" used elsewhere (timeline block meta, total-duration readout).
function _fmtTimecode(s) {
    const clamped = Math.max(0, s || 0);
    const m = Math.floor(clamped / 60);
    const sec = clamped - m * 60;
    return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
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
        nameEl.textContent = `${clip.kind === "image" ? "🖼" : "🎬"} ${clip.name}`;
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
    setDisabled("wfm-video-edit-preview-btn", _s.clips.length === 0);
    _updateTotalDuration();
}

function _updateTotalDuration() {
    const el = document.getElementById("wfm-video-edit-total-duration");
    if (!el) return;
    const total = _s.clips.reduce((sum, c) => {
        if (c.probing || c.error) return sum;
        return sum + Math.max(0, c.trimEnd - c.trimStart);
    }, 0);
    el.textContent = _s.clips.length === 0 ? "" : t("videoEditTotalDuration", _fmtTime(total));
}

// ============================================
// Trim scrubber — Clipchamp-style visual timeline for the selected video
// clip's trim panel: a time ruler, a draggable in/out range, and a playhead
// synced to the Source preview's <video> element. All positions are computed
// as percentages of clip.duration (not px/sec) so no separate zoom/scale
// bookkeeping is needed — the track just fills whatever width the panel gives it.
// ============================================

// Tracks the (element, listener) pair currently wired to a <video>'s
// "timeupdate" so it can be torn down before the next clip selection reuses
// the same persistent preview element (see video-preview.js) — otherwise
// listeners would pile up across every clip switch.
let _scrubVideoEl = null;
let _scrubVideoListener = null;

function _teardownTrimScrubber() {
    if (_scrubVideoEl && _scrubVideoListener) {
        _scrubVideoEl.removeEventListener("timeupdate", _scrubVideoListener);
    }
    _scrubVideoEl = null;
    _scrubVideoListener = null;
}

// "Nice" tick spacing so the ruler shows roughly 5-8 labeled ticks regardless
// of clip length (a 3s clip gets 0.5s ticks, a 5min clip gets 60s ticks).
function _niceRulerStep(duration) {
    const rough = duration / 6;
    const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return candidates.find((c) => c >= rough) || candidates[candidates.length - 1];
}

function _renderRuler(ruler, duration) {
    ruler.innerHTML = "";
    if (!duration) return;
    const step = _niceRulerStep(duration);
    for (let time = 0; time <= duration + 0.001; time += step) {
        const tick = document.createElement("span");
        tick.className = "wfm-video-trim-ruler-tick";
        tick.style.left = `${Math.min(100, (time / duration) * 100)}%`;
        tick.textContent = _fmtTimecode(time).replace(/\.\d+$/, "");
        ruler.appendChild(tick);
    }
}

// Wires the scrubber DOM (already inserted into the trim panel by
// _renderTrimPanel) for one video clip. `commit` is the trim-panel's own
// start/end-input commit function — the scrubber drives it via the same
// inputs rather than writing clip.trimStart/trimEnd directly, so both paths
// (typed numbers, dragged handles) stay in sync through one code path.
function _wireTrimScrubber(clip, startInput, endInput, commit) {
    const track = document.getElementById("wfm-video-trim-track");
    const ruler = document.getElementById("wfm-video-trim-ruler");
    const rangeEl = document.getElementById("wfm-video-trim-range");
    const handleStart = document.getElementById("wfm-video-trim-handle-start");
    const handleEnd = document.getElementById("wfm-video-trim-handle-end");
    const playhead = document.getElementById("wfm-video-trim-playhead");
    const badgeStart = document.getElementById("wfm-video-trim-badge-start");
    const badgeEnd = document.getElementById("wfm-video-trim-badge-end");
    const badgePlayhead = document.getElementById("wfm-video-trim-badge-playhead");
    if (!track || !clip.duration) return;

    _renderRuler(ruler, clip.duration);

    const pct = (t) => `${Math.min(100, Math.max(0, (t / clip.duration) * 100))}%`;

    function updateRange() {
        rangeEl.style.left = pct(clip.trimStart);
        rangeEl.style.width = `${Math.max(0, ((Math.min(clip.trimEnd, clip.duration) - clip.trimStart) / clip.duration) * 100)}%`;
        handleStart.style.left = pct(clip.trimStart);
        handleEnd.style.left = pct(clip.trimEnd);
        badgeStart.textContent = _fmtTimecode(clip.trimStart);
        badgeEnd.textContent = _fmtTimecode(clip.trimEnd);
    }
    updateRange();

    function updatePlayhead(t) {
        playhead.style.left = pct(t);
        badgePlayhead.textContent = _fmtTimecode(t);
    }

    const video = getActivePreviewVideoElement();
    if (video) {
        _scrubVideoEl = video;
        _scrubVideoListener = () => updatePlayhead(video.currentTime);
        video.addEventListener("timeupdate", _scrubVideoListener);
        updatePlayhead(video.currentTime);
    } else {
        updatePlayhead(0);
    }

    function seekTo(clientX) {
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const t = ratio * clip.duration;
        const v = getActivePreviewVideoElement();
        if (v) v.currentTime = t;
        updatePlayhead(t);
    }

    // Drags a trim handle: while pointer is down, only the scrubber's own
    // visuals (range/handle position, badge text) update — clip.trimStart/End
    // and the timeline block widths commit once on pointerup, so dragging
    // doesn't thrash _renderTimeline() on every mousemove.
    function wireHandleDrag(handleEl, isStart) {
        handleEl.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleEl.setPointerCapture(e.pointerId);
            const onMove = (ev) => {
                const rect = track.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
                const t = ratio * clip.duration;
                if (isStart) startInput.value = Math.min(t, clip.trimEnd - 0.05).toFixed(2);
                else endInput.value = Math.max(t, clip.trimStart + 0.05).toFixed(2);
                commit({ skipTimelineRerender: true });
                updateRange();
            };
            const onUp = () => {
                handleEl.removeEventListener("pointermove", onMove);
                handleEl.removeEventListener("pointerup", onUp);
                _renderTimeline();
            };
            handleEl.addEventListener("pointermove", onMove);
            handleEl.addEventListener("pointerup", onUp);
        });
    }
    wireHandleDrag(handleStart, true);
    wireHandleDrag(handleEnd, false);

    track.addEventListener("pointerdown", (e) => {
        if (e.target === handleStart || e.target === handleEnd || e.target === playhead) return;
        seekTo(e.clientX);
    });

    playhead.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        playhead.setPointerCapture(e.pointerId);
        const onMove = (ev) => seekTo(ev.clientX);
        const onUp = () => {
            playhead.removeEventListener("pointermove", onMove);
            playhead.removeEventListener("pointerup", onUp);
        };
        playhead.addEventListener("pointermove", onMove);
        playhead.addEventListener("pointerup", onUp);
    });
}

function _renderTrimPanel() {
    const panel = document.getElementById("wfm-video-edit-trim-panel");
    if (!panel) return;
    _teardownTrimScrubber();
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
    if (clip.kind === "image") {
        panel.innerHTML = `
            <div class="wfm-video-edit-clip-name" id="wfm-video-edit-trim-clip-name" style="margin-bottom:6px;"></div>
            <div class="wfm-video-edit-trim-field" style="max-width:160px;">
                <label>${t("videoEditImageDuration")}</label>
                <input type="number" id="wfm-video-edit-image-duration" class="wfm-input" step="0.1" min="0.1" value="${clip.trimEnd.toFixed(2)}">
            </div>
        `;
        const nameEl = document.getElementById("wfm-video-edit-trim-clip-name");
        if (nameEl) { nameEl.textContent = clip.name; nameEl.title = clip.name; }

        const durInput = document.getElementById("wfm-video-edit-image-duration");
        durInput.addEventListener("change", () => {
            const val = Math.max(0.1, Number(durInput.value) || _DEFAULT_IMAGE_DURATION);
            clip.trimEnd = val;
            clip.duration = val;
            durInput.value = val.toFixed(2);
            _renderTimeline();
        });
        return;
    }

    panel.innerHTML = `
        <div class="wfm-video-edit-clip-name" id="wfm-video-edit-trim-clip-name" style="margin-bottom:6px;"></div>
        <div class="wfm-video-trim-scrubber" id="wfm-video-trim-scrubber">
            <div class="wfm-video-trim-ruler" id="wfm-video-trim-ruler"></div>
            <div class="wfm-video-trim-track" id="wfm-video-trim-track">
                <div class="wfm-video-trim-range" id="wfm-video-trim-range"></div>
                <div class="wfm-video-trim-handle" id="wfm-video-trim-handle-start">
                    <span class="wfm-video-trim-badge" id="wfm-video-trim-badge-start"></span>
                </div>
                <div class="wfm-video-trim-handle" id="wfm-video-trim-handle-end">
                    <span class="wfm-video-trim-badge" id="wfm-video-trim-badge-end"></span>
                </div>
                <div class="wfm-video-trim-playhead" id="wfm-video-trim-playhead">
                    <span class="wfm-video-trim-badge wfm-video-trim-badge-playhead" id="wfm-video-trim-badge-playhead"></span>
                </div>
            </div>
        </div>
        <div class="wfm-video-edit-trim-row" style="margin-top:10px;">
            <div class="wfm-video-edit-trim-field">
                <label>${t("videoEditTrimStart")}</label>
                <input type="number" id="wfm-video-edit-trim-start" class="wfm-input" step="0.1" min="0" max="${clip.duration}" value="${clip.trimStart.toFixed(2)}">
                <button type="button" class="wfm-btn wfm-btn-xs wfm-video-edit-playhead-btn" id="wfm-video-edit-trim-start-set">${t("videoEditSetFromPlayhead")}</button>
            </div>
            <div class="wfm-video-edit-trim-field">
                <label>${t("videoEditTrimEnd")}</label>
                <input type="number" id="wfm-video-edit-trim-end" class="wfm-input" step="0.1" min="0" max="${clip.duration}" value="${clip.trimEnd.toFixed(2)}">
                <button type="button" class="wfm-btn wfm-btn-xs wfm-video-edit-playhead-btn" id="wfm-video-edit-trim-end-set">${t("videoEditSetFromPlayhead")}</button>
            </div>
        </div>
    `;
    const nameEl = document.getElementById("wfm-video-edit-trim-clip-name");
    if (nameEl) { nameEl.textContent = clip.name; nameEl.title = clip.name; }

    const startInput = document.getElementById("wfm-video-edit-trim-start");
    const endInput = document.getElementById("wfm-video-edit-trim-end");

    // skipTimelineRerender: the scrubber's handle-drag calls this on every
    // pointermove (see _wireTrimScrubber) — re-running _renderTimeline() that
    // often would rebuild every timeline block per mousemove for no visible
    // benefit, since the scrubber already redraws its own range live.
    const commit = ({ skipTimelineRerender } = {}) => {
        let start = Math.max(0, Math.min(Number(startInput.value) || 0, clip.duration));
        let end = Math.max(0, Math.min(Number(endInput.value) || 0, clip.duration));
        if (end <= start) end = Math.min(clip.duration, start + 0.1);
        clip.trimStart = start;
        clip.trimEnd = end;
        startInput.value = start.toFixed(2);
        endInput.value = end.toFixed(2);
        if (!skipTimelineRerender) _renderTimeline();
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

    _wireTrimScrubber(clip, startInput, endInput, commit);
}

// ============================================
// Sequential timeline preview — plays every ready clip back-to-back (each
// trimmed to its in/out point) in the shared "Result" pane (the same one
// Export writes its finished output into), so what plays there is always
// exactly what Export would currently produce. Deliberately reuses that pane
// rather than a third <video> element: the user asked for it to be the same
// slot the exported video lands in, not a separate preview area.
// ============================================

let _previewPlaying = false;
let _previewClips = [];
let _previewIndex = 0;
let _previewImageTimer = null; // holds an image clip on screen for its duration (setTimeout, no video events to hook)

function _onPreviewTimeUpdate() {
    const video = getResultPreviewVideoElement();
    const clip = _previewClips[_previewIndex];
    if (!video || !clip || clip.kind !== "video") return;
    if (video.currentTime >= clip.trimEnd) _advancePreview();
}

function _advancePreview() {
    _previewIndex += 1;
    if (_previewIndex >= _previewClips.length) { _stopPreview(); return; }
    _playPreviewClip();
}

function _playPreviewClip() {
    const clip = _previewClips[_previewIndex];
    if (!clip) { _stopPreview(); return; }

    if (clip.kind === "image") {
        const video = getResultPreviewVideoElement();
        video?.pause();
        setResultPreview(URL.createObjectURL(clip.file), { kind: "local", file: clip.file }, "image");
        const holdMs = Math.max(50, (clip.trimEnd - clip.trimStart) * 1000);
        _previewImageTimer = setTimeout(_advancePreview, holdMs);
        return;
    }

    const video = getResultPreviewVideoElement();
    if (!video) { _stopPreview(); return; }
    setResultPreview(URL.createObjectURL(clip.file), { kind: "local", file: clip.file }, "video");
    // currentTime only reliably applies once the new source has metadata —
    // setting it immediately after swapping src is flaky across browsers.
    const onReady = () => {
        video.removeEventListener("loadedmetadata", onReady);
        video.currentTime = clip.trimStart;
        video.play().catch(() => {});
    };
    video.addEventListener("loadedmetadata", onReady);
}

function _startPreview() {
    _previewClips = _s.clips.filter((c) => !c.probing && !c.error);
    if (_previewClips.length === 0) {
        showToast(t("videoEditNoClips"), "error");
        return;
    }
    _previewIndex = 0;
    _previewPlaying = true;
    const video = getResultPreviewVideoElement();
    video?.addEventListener("timeupdate", _onPreviewTimeUpdate);
    video?.addEventListener("ended", _advancePreview);
    _playPreviewClip();
    _updatePreviewBtn();
}

function _stopPreview() {
    _previewPlaying = false;
    if (_previewImageTimer) { clearTimeout(_previewImageTimer); _previewImageTimer = null; }
    const video = getResultPreviewVideoElement();
    video?.removeEventListener("timeupdate", _onPreviewTimeUpdate);
    video?.removeEventListener("ended", _advancePreview);
    video?.pause();
    _updatePreviewBtn();
}

function _togglePreview() {
    if (_previewPlaying) _stopPreview();
    else _startPreview();
}

function _updatePreviewBtn() {
    const btn = document.getElementById("wfm-video-edit-preview-btn");
    if (btn) btn.textContent = _previewPlaying ? t("videoEditPreviewStop") : t("videoEditPreviewPlay");
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

    // Auto-fit target for image clips: the first VIDEO clip's resolution, so
    // a still dropped alongside real footage doesn't need to be pre-sized by
    // hand (see _findResolutionMismatch, which only ever compares VIDEO
    // clips against each other — images are exempt because of this fit step).
    const videoClip = clips.find((c) => c.kind === "video");
    const targetW = videoClip ? videoClip.width : clips[0]?.width;
    const targetH = videoClip ? videoClip.height : clips[0]?.height;

    // Only strip audio when clips will actually be concatenated — a single
    // video clip never goes through ConcatenateVideo, so there's no mixed-
    // audio compatibility problem to avoid and its audio can be kept intact.
    const needsUniformSilence = clips.length > 1;

    for (const clip of clips) {
        const file = clip.serverRef.subfolder
            ? `${clip.serverRef.subfolder}/${clip.serverRef.filename}`
            : clip.serverRef.filename;

        if (clip.kind === "image") {
            const loadId = alloc();
            prompt[loadId] = { class_type: "LoadImage", inputs: { image: file } };
            let imageOut = [loadId, 0];

            if (targetW && targetH && (clip.width !== targetW || clip.height !== targetH)) {
                const scaleId = alloc();
                prompt[scaleId] = {
                    class_type: "ImageScale",
                    inputs: { image: imageOut, upscale_method: "lanczos", width: targetW, height: targetH, crop: "center" },
                };
                imageOut = [scaleId, 0];
            }

            const repeatId = alloc();
            const amount = Math.max(1, Math.round((clip.trimEnd - clip.trimStart) * _IMAGE_EXPORT_FPS));
            prompt[repeatId] = { class_type: "RepeatImageBatch", inputs: { image: imageOut, amount } };

            const createId = alloc();
            prompt[createId] = {
                class_type: "CreateVideo",
                inputs: { images: [repeatId, 0], fps: _IMAGE_EXPORT_FPS, codec: "auto" },
            };
            trimOutputs.push(createId);
            continue;
        }

        const loadId = alloc();
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

        if (!needsUniformSilence) {
            trimOutputs.push(trimId);
            continue;
        }

        // Strip audio by decomposing/recomposing through GetVideoComponents ->
        // CreateVideo (audio input left unset). Verified on a live instance:
        // ConcatenateVideo hard-errors mixing a clip with stereo/32kHz audio
        // next to a silent image-derived clip ("audio layout: expected None,
        // got 'stereo'"), so every clip is made silent whenever more than one
        // clip is being concatenated. This means a multi-clip export never
        // carries audio — a known MVP limitation, not handled per-clip
        // because ConcatenateVideo needs uniform audio across all inputs. A
        // lone clip (see needsUniformSilence above) keeps its original audio.
        const componentsId = alloc();
        prompt[componentsId] = { class_type: "GetVideoComponents", inputs: { video: [trimId, 0] } };
        const silentId = alloc();
        prompt[silentId] = {
            class_type: "CreateVideo",
            inputs: { images: [componentsId, 0], fps: [componentsId, 2], codec: "auto" },
        };
        trimOutputs.push(silentId);
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
    _stopPreview();

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
    document.getElementById("wfm-video-edit-preview-btn")?.addEventListener("click", _togglePreview);
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
    _wireToolbar();
    document.getElementById("wfm-video-edit-export-btn")?.addEventListener("click", _exportTimeline);
    _renderTimeline();
    _renderTrimPanel();
    _updatePreviewBtn();
}
