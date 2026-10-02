/**
 * Models Tab - Small path/preview helpers shared across the models/* modules
 */

import { state } from "./state.js";
import { safeHttpUrl } from "../util.js";

export function parseModelPath(fullName) {
    const lastSlash = Math.max(fullName.lastIndexOf("/"), fullName.lastIndexOf("\\"));
    if (lastSlash === -1) return { dir: "", name: fullName };
    return { dir: fullName.substring(0, lastSlash), name: fullName.substring(lastSlash + 1) };
}

export function getExtension(name) {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.substring(dot) : "";
}

export function getStem(name) {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.substring(0, dot) : name;
}

export function previewUrl(modelName, modelType) {
    const type = modelType || state.activeModelType;
    return `/api/wfm/models/preview?type=${encodeURIComponent(type)}&name=${encodeURIComponent(modelName)}`;
}

/**
 * Load preview image. Uses img onload/onerror instead of HEAD request
 * (aiohttp add_get does not auto-handle HEAD method).
 * Falls back to CivitAI cached image if no local preview exists.
 */
/** モデル名 → previewKeys のキー（`サブフォルダ/拡張子なし名`、小文字・/区切り） */
export function previewKey(modelName) {
    const n = modelName.replace(/\\/g, "/");
    const dot = n.lastIndexOf(".");
    const slash = n.lastIndexOf("/");
    return (dot > slash ? n.substring(0, dot) : n).toLowerCase();
}

/** プレビュー画像を持つモデルのキー一覧をサーバから取得してstateに保存。失敗時は保存せず従来動作に戻る */
export async function fetchPreviewKeys(modelType) {
    const type = modelType || state.activeModelType;
    try {
        const res = await fetch(`/api/wfm/models/preview-keys?type=${encodeURIComponent(type)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.keys)) state.previewKeys[type] = new Set(data.keys);
    } catch { /* 従来動作（都度リクエスト）にフォールバック */ }
}

/** 新しくプレビューが作られた/変更されたモデルを登録する */
export function markHasPreview(modelName, modelType) {
    const set = state.previewKeys[modelType || state.activeModelType];
    if (set) set.add(previewKey(modelName));
}

export function loadPreviewImage(imgEl, placeholderEl, modelName, modelType) {
    const url = previewUrl(modelName, modelType);
    const keys = state.previewKeys[modelType || state.activeModelType];
    const noLocalPreview = !!keys && !keys.has(previewKey(modelName));
    imgEl.onload = () => {
        imgEl.style.display = "";
        if (placeholderEl) placeholderEl.style.display = "none";
    };
    imgEl.onerror = () => {
        // Fallback: use CivitAI cached image if available
        const meta = state.modelMetadata[modelName] || {};
        const sha256 = meta.sha256;
        const civitai = sha256 && state.civitaiCache[sha256];
        const civitaiImg = safeHttpUrl(civitai && civitai.images && civitai.images[0]);
        if (civitaiImg) {
            imgEl.onerror = () => {
                imgEl.style.display = "none";
                if (placeholderEl) placeholderEl.style.display = "";
            };
            imgEl.src = civitaiImg;
            imgEl.style.display = "";
            if (placeholderEl) placeholderEl.style.display = "none";
        } else {
            imgEl.style.display = "none";
            if (placeholderEl) placeholderEl.style.display = "";
        }
    };
    if (noLocalPreview) { imgEl.onerror(); return; }
    imgEl.src = url;
}
