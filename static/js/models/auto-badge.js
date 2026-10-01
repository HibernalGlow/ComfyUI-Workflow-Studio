/**
 * Models Tab - Auto badges from CivitAI base model info
 *
 * CivitAI's `baseModel` is already a categorical string, so labels are derived
 * with a deterministic rule table (variants such as "SDXL 1.0" / "SDXL Turbo"
 * collapse into one family badge). Unknown strings fall back to the raw value.
 * Apply semantics: model badges are appended (existing badges are kept);
 * a label already in the palette gets its color overwritten (optional).
 */

import { openModal, closeModal, showToast } from "../app.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../util.js";
import { state } from "./state.js";
import { getCurrentModels } from "./filters.js";
import { getBadgePalette, saveBadgePalette, renderBadgeFilter } from "./badges.js";
import { renderModelGrid } from "./grid-view.js";
import { saveModelMetadata } from "../models-tab.js";

// [pattern, label, color] — first match wins, so specific families come first.
const FAMILY_RULES = [
    [/^pony/i, "Pony", "#d946ef"],
    [/^illustrious/i, "Illustrious", "#f59e0b"],
    [/^noobai/i, "NoobAI", "#14b8a6"],
    [/^sdxl|^sd ?xl/i, "SDXL", "#3b82f6"],
    [/^sd ?1\.[45]/i, "SD1.5", "#22c55e"],
    [/^sd ?2/i, "SD2", "#84cc16"],
    [/^sd ?3/i, "SD3", "#06b6d4"],
    [/^flux\.?1|^flux$/i, "Flux.1", "#ef4444"],
    [/^flux\.?2/i, "Flux.2", "#dc2626"],
    [/^qwen/i, "Qwen", "#8b5cf6"],
    [/^wan/i, "Wan", "#0ea5e9"],
    [/^z-?image/i, "Z-Image", "#ec4899"],
    [/^hidream/i, "HiDream", "#f97316"],
    [/^hunyuan/i, "Hunyuan", "#6366f1"],
    [/^chroma/i, "Chroma", "#a855f7"],
    [/^lumina/i, "Lumina", "#10b981"],
    [/^auraflow/i, "AuraFlow", "#64748b"],
    [/^kolors/i, "Kolors", "#e11d48"],
];
const SKIP_VALUES = new Set(["", "other", "unknown"]);
const FALLBACK_COLORS = ["#0891b2", "#7c3aed", "#be185d", "#b45309", "#4d7c0f", "#475569"];

export function baseModelToBadge(baseModel) {
    const raw = (baseModel || "").trim();
    if (SKIP_VALUES.has(raw.toLowerCase())) return null;
    for (const [re, label, color] of FAMILY_RULES) {
        if (re.test(raw)) return { label, color };
    }
    let h = 0;
    for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return { label: raw, color: FALLBACK_COLORS[h % FALLBACK_COLORS.length] };
}

/** Scan current-type models → { assignments: [{model, label}], labels: Map(label → {color, count}) } */
function buildPlan() {
    const assignments = [];
    const labels = new Map();
    let noInfo = 0;
    for (const m of getCurrentModels()) {
        const sha = state.modelMetadata[m]?.sha256;
        const civ = sha && state.civitaiCache[sha];
        const badge = civ ? baseModelToBadge(civ.baseModel) : null;
        if (!badge) { noInfo++; continue; }
        assignments.push({ model: m, label: badge.label });
        const entry = labels.get(badge.label) || { color: badge.color, count: 0 };
        entry.count++;
        labels.set(badge.label, entry);
    }
    return { assignments, labels, noInfo };
}

export function openAutoBadgeModal(onDone = null) {
    const { assignments, labels, noInfo } = buildPlan();
    if (assignments.length === 0) {
        showToast(t("autoBadgeNoData"), "warning");
        return;
    }
    const palette = getBadgePalette();
    const rows = [...labels.entries()].sort((a, b) => b[1].count - a[1].count).map(([label, info]) => {
        const exists = label in palette;
        return `<div class="wfm-badge-color-row">
            <span class="wfm-badge wfm-badge-model" style="background:${info.color};color:#fff;">${escapeHtml(label)}</span>
            <span style="font-size:12px;">${info.count}</span>
            <span style="font-size:11px;color:var(--wfm-text-secondary);">${exists ? t("autoBadgeExisting") : t("autoBadgeNew")}</span>
        </div>`;
    }).join("");

    openModal(t("autoBadgeTitle"), `
        <div style="min-width:340px;">
            <p style="font-size:12px;color:var(--wfm-text-secondary);margin:0 0 8px;">${t("autoBadgeDesc")}</p>
            ${rows}
            <p style="font-size:11px;color:var(--wfm-text-secondary);">${t("autoBadgeNoInfo")}: ${noInfo}</p>
            <label style="font-size:12px;display:block;margin:8px 0;">
                <input type="checkbox" id="wfm-auto-badge-overwrite" checked> ${t("autoBadgeOverwrite")}
            </label>
            <label style="font-size:12px;display:block;margin:8px 0;">
                <input type="checkbox" id="wfm-auto-badge-skip"> ${t("autoBadgeSkipExisting")}
            </label>
            <button class="wfm-btn wfm-btn-sm wfm-btn-primary" id="wfm-auto-badge-apply">${t("autoBadgeApply")} (${assignments.length})</button>
        </div>`);

    const hasBadges = (m) => (state.modelMetadata[m]?.badges || []).length > 0;
    const targets = () => document.getElementById("wfm-auto-badge-skip")?.checked
        ? assignments.filter(({ model }) => !hasBadges(model)) : assignments;
    document.getElementById("wfm-auto-badge-skip")?.addEventListener("change", () => {
        const btn = document.getElementById("wfm-auto-badge-apply");
        if (btn) btn.textContent = `${t("autoBadgeApply")} (${targets().length})`;
    });

    document.getElementById("wfm-auto-badge-apply")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        const overwrite = document.getElementById("wfm-auto-badge-overwrite")?.checked;
        const target = targets();
        const pal = getBadgePalette();
        const usedLabels = new Set(target.map((a) => a.label));
        for (const [label, info] of labels) {
            if (!usedLabels.has(label)) continue;
            if (!(label in pal) || overwrite) pal[label] = info.color;
        }
        saveBadgePalette(pal);

        const todo = target.filter(({ model, label }) => !(state.modelMetadata[model]?.badges || []).includes(label));
        for (let i = 0; i < todo.length; i += 8) {
            await Promise.all(todo.slice(i, i + 8).map(({ model, label }) => {
                const badges = [...(state.modelMetadata[model]?.badges || []), label];
                return saveModelMetadata(model, { badges });
            }));
        }
        renderBadgeFilter();
        renderModelGrid();
        showToast(`${todo.length} ${t("autoBadgeDone")}`, "success");
        closeModal();
        if (onDone) onDone();
    });
}
