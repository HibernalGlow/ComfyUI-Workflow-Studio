/**
 * Video Tab - shared state for the two center-panel preview panes:
 * "source" (#wfm-video-source-preview-video — an Asset selection or a
 * locally-dropped file) and "result" (#wfm-video-preview-video — the latest
 * generated clip). video-asset-tab.js (Asset selection), video-plan-tab.js
 * (batch run results) and video-tab.js (the Video Source drop zone, Frame/GIF
 * tools) all need to read or write these. Pulling this into its own module
 * lets all three depend on it without needing to import each other —
 * video-tab.js already imports both of the others for init/refresh, so a
 * reverse import from either back into video-tab.js would create a cycle.
 *
 * Each pane also has a companion <img> element (wfm-video-*-preview-img) so a
 * still/animated image (from Asset or a Video Source drop) can be previewed
 * without forcing it through a <video> tag, which can't render image formats
 * at all. mediaType controls which element is shown; Frame/GIF's
 * getActivePreviewVideoElement() returns null while a pane is showing an
 * image, since those tools only make sense against real video.
 */

const _PANES = {
    source: { video: "wfm-video-source-preview-video", img: "wfm-video-source-preview-img", placeholder: "wfm-video-source-preview-placeholder" },
    result: { video: "wfm-video-preview-video", img: "wfm-video-preview-img", placeholder: "wfm-video-preview-placeholder" },
};

const _objectUrls = { source: null, result: null };

// Whichever pane most recently received media is what the Frame/GIF property
// tabs act on (see getActivePreviewSource/getActivePreviewVideoElement below) —
// an Asset selection or Video Source drop activates "source", a batch run
// finishing a block (or the Edit tab's export/preview) activates "result".
let _activePane = null; // "source" | "result" | null
let _activeSource = null;
let _activeMediaType = null; // "video" | "image" | null — mirrors _activePane's current content

function _setPreview(pane, url, source, mediaType = "video") {
    const ids = _PANES[pane];
    const video = document.getElementById(ids.video);
    const img = document.getElementById(ids.img);
    const placeholder = document.getElementById(ids.placeholder);
    if (!video || !placeholder) return;

    if (_objectUrls[pane]) {
        URL.revokeObjectURL(_objectUrls[pane]);
        _objectUrls[pane] = null;
    }
    if (url && url.startsWith("blob:")) _objectUrls[pane] = url;

    if (url) {
        if (mediaType === "image") {
            video.pause();
            video.removeAttribute("src");
            video.load();
            video.style.display = "none";
            if (img) { img.src = url; img.style.display = "block"; }
        } else {
            if (img) { img.removeAttribute("src"); img.style.display = "none"; }
            video.src = url;
            video.style.display = "block";
        }
        placeholder.style.display = "none";
        _activePane = pane;
        _activeSource = source;
        _activeMediaType = mediaType;
    } else {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.style.display = "none";
        if (img) { img.removeAttribute("src"); img.style.display = "none"; }
        placeholder.style.display = "";
        if (_activePane === pane) { _activePane = null; _activeSource = null; _activeMediaType = null; }
    }
}

// Sets (or clears, with url=null) the Asset-selection/Video-Source-drop pane.
// mediaType: "video" (default) or "image".
export function setSourcePreview(url, source, mediaType = "video") { _setPreview("source", url, source, mediaType); }

// Sets (or clears) the generated-result pane — called once per block as a
// batch run's video output comes in, and by the Edit tab's timeline preview
// (which may show either a video clip or a held still image).
export function setResultPreview(url, source, mediaType = "video") { _setPreview("result", url, source, mediaType); }

// What the Frame/GIF property tabs operate on: { kind: "output"|"input", filename,
// subfolder, type } for anything already on the server, or { kind: "local", file }
// for a picked/dropped file not yet uploaded. null if neither pane has media.
export function getActivePreviewSource() { return _activeSource; }

// The GIF tab uploads a still-local source on first use and needs to remember
// the resulting server-side reference so a repeat conversion doesn't re-upload —
// this rewrites the active source in place without touching either <video> element.
export function updateActivePreviewSourceRef(source) { _activeSource = source; }

// The <video> element the Frame/GIF tools should read/capture from, or null if
// neither pane currently has a video loaded (including when the active pane is
// showing a still image instead).
export function getActivePreviewVideoElement() {
    if (!_activePane || _activeMediaType === "image") return null;
    return document.getElementById(_PANES[_activePane].video);
}

// Both panes' <video> elements share the same persistent volume setting.
export function getAllPreviewVideoElements() {
    return Object.values(_PANES).map((ids) => document.getElementById(ids.video)).filter(Boolean);
}

// Direct access to the "result" pane's <video> element — used by
// video-edit-tab.js's timeline preview, which needs to drive playback
// (seek to a clip's trim-in, listen for the trim-out point, swap to the
// next clip) rather than just set a src via setResultPreview().
export function getResultPreviewVideoElement() {
    return document.getElementById(_PANES.result.video);
}
