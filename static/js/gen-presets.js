/**
 * Generation & Sampler Presets Module
 * Provides one-click saving, loading, and switching of complete confirmed setups
 * (single/double sampling, steps, cfg, sampler, scheduler, and LoRA mixtures).
 */

import { comfyUI } from "./comfyui-client.js";
import { showToast, openModal, closeModal } from "./app.js";
import { escapeHtml } from "./util.js";
import { t } from "./i18n.js";
import { storyLoraState, renderMatchedLorasList } from "./prompt-story-lora.js";

export const genPresetsState = {
    presets: [],
    activePresetId: null,
};

/**
 * Fetch all generation presets from server
 */
export async function fetchGenPresets() {
    try {
        const res = await fetch("/api/wfm/gen_presets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        genPresetsState.presets = await res.json();
        return genPresetsState.presets;
    } catch (e) {
        console.error("Error fetching gen presets:", e);
        return [];
    }
}

/**
 * Initialize the Presets UI Widget
 */
export async function initGenPresetsWidget(containerEl) {
    if (!containerEl) return;

    await fetchGenPresets();

    containerEl.innerHTML = `
        <div class="wfm-gen-preset-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--wfm-bg-tertiary);border:1px solid var(--wfm-border);border-radius:6px;margin-bottom:12px;">
            <span style="font-weight:600;font-size:12px;white-space:nowrap;display:flex;align-items:center;gap:4px;">
                📌 ${t("genPresetLabel") || "常用预设"}:
            </span>
            <select id="wfm-gen-preset-select" class="wfm-select" style="flex:1;min-width:180px;font-size:12px;padding:4px 8px;">
                <option value="">${t("selectPresetHint") || "-- 选择常用预设 / 一键装配最佳参数 --"}</option>
                ${genPresetsState.presets.map((p) => `<option value="${p.id}" ${p.id === genPresetsState.activePresetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
            </select>
            <button type="button" id="wfm-gen-preset-apply-btn" class="wfm-btn wfm-btn-xs wfm-btn-primary" title="一键将该预设的采样步数、CFG、单/双采样模式与LoRA权重注入当前工作流">
                ⚡ ${t("applyPresetBtn") || "应用预设"}
            </button>
            <button type="button" id="wfm-gen-preset-save-btn" class="wfm-btn wfm-btn-xs" title="将当前界面的采样参数与激活的LoRA保存为新预设">
                💾 ${t("saveAsPresetBtn") || "保存当前"}
            </button>
            <button type="button" id="wfm-gen-preset-del-btn" class="wfm-btn wfm-btn-xs wfm-btn-danger" style="display:none;" title="删除当前选中的自定义预设">
                🗑️
            </button>
        </div>
    `;

    const selectEl = document.getElementById("wfm-gen-preset-select");
    const applyBtn = document.getElementById("wfm-gen-preset-apply-btn");
    const saveBtn = document.getElementById("wfm-gen-preset-save-btn");
    const delBtn = document.getElementById("wfm-gen-preset-del-btn");

    selectEl?.addEventListener("change", (e) => {
        const pid = e.target.value;
        genPresetsState.activePresetId = pid;
        const preset = genPresetsState.presets.find(p => p.id === pid);
        if (delBtn) {
            delBtn.style.display = (preset && !preset.id.startsWith("anima-") && !preset.id.startsWith("liino-")) ? "inline-block" : "none";
        }
        if (preset) {
            applyPreset(preset);
        }
    });

    applyBtn?.addEventListener("click", () => {
        const pid = selectEl?.value;
        const preset = genPresetsState.presets.find(p => p.id === pid);
        if (!preset) {
            showToast("请先选择一个预设", "warning");
            return;
        }
        applyPreset(preset);
    });

    saveBtn?.addEventListener("click", () => {
        openSavePresetModal();
    });

    delBtn?.addEventListener("click", async () => {
        const pid = selectEl?.value;
        if (!pid) return;
        if (!confirm("确定要删除此预设吗？")) return;
        try {
            await fetch(`/api/wfm/gen_presets/${pid}`, { method: "DELETE" });
            showToast("预设已删除", "info");
            genPresetsState.activePresetId = null;
            await initGenPresetsWidget(containerEl);
        } catch (e) {
            showToast(`删除失败: ${e.message}`, "error");
        }
    });
}

/**
 * Apply preset to current workflow & UI
 */
export async function applyPreset(preset) {
    if (!preset) return;

    if (!comfyUI.currentWorkflow) {
        showToast("未检测到已加载的工作流", "warning");
        return;
    }

    try {
        const res = await fetch("/api/wfm/gen_presets/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                workflow: comfyUI.currentWorkflow,
                preset: preset
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        comfyUI.currentWorkflow = data.workflow;

        // Sync LoRAs to storyLoraState if present
        if (Array.isArray(preset.loras) && preset.loras.length > 0) {
            storyLoraState.matchedLoras = preset.loras.map(l => ({ ...l, active: l.active !== false }));
            renderMatchedLorasList();
        }

        // Sync positive prefix if prompt textarea is empty or user wants
        const posTextarea = document.getElementById("wfm-prompt-pos-text");
        if (posTextarea && preset.quality_prefix && !posTextarea.value.trim()) {
            posTextarea.value = preset.quality_prefix;
        }

        // Sync negative prompt if empty
        const negTextarea = document.getElementById("wfm-prompt-neg-text");
        if (negTextarea && preset.default_negative && !negTextarea.value.trim()) {
            negTextarea.value = preset.default_negative;
        }

        // Trigger workflow re-analysis and UI update
        if (typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new CustomEvent("wfm:workflow-updated", { detail: { workflow: comfyUI.currentWorkflow } }));
        }

        showToast(`已成功装配预设: ${preset.name}`, "success");
    } catch (e) {
        console.error("Error applying preset:", e);
        showToast(`应用预设失败: ${e.message}`, "error");
    }
}

/**
 * Open Modal to save current configuration as a new Preset
 */
function openSavePresetModal() {
    const activeLoras = (storyLoraState.matchedLoras || []).filter(l => l.active !== false);

    const content = `
        <div style="display:flex;flex-direction:column;gap:12px;">
            <div class="wfm-form-group">
                <label>预设名称 (Preset Name):</label>
                <input type="text" id="wfm-modal-preset-name" class="wfm-input" placeholder="例如：我的15步单采样微调" value="自定义预设">
            </div>
            <div class="wfm-form-group">
                <label>预设说明 (Description):</label>
                <textarea id="wfm-modal-preset-desc" class="wfm-textarea" rows="2" placeholder="备注使用场景或模型类型"></textarea>
            </div>
            <div class="wfm-form-group">
                <label>采样模式 (Sampling Mode):</label>
                <div style="display:flex;gap:16px;">
                    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
                        <input type="radio" name="wfm-modal-preset-smode" value="single" checked> 单采样 (Single-Pass)
                    </label>
                    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
                        <input type="radio" name="wfm-modal-preset-smode" value="double"> 双层采样 (Two-Stage)
                    </label>
                </div>
            </div>
            <div style="display:flex;gap:12px;">
                <div class="wfm-form-group" style="flex:1;">
                    <label>采样步数 (Steps):</label>
                    <input type="number" id="wfm-modal-preset-steps" class="wfm-input" value="12">
                </div>
                <div class="wfm-form-group" style="flex:1;">
                    <label>CFG Scale:</label>
                    <input type="number" id="wfm-modal-preset-cfg" class="wfm-input" step="0.1" value="1.6">
                </div>
            </div>
            <div style="display:flex;gap:12px;">
                <div class="wfm-form-group" style="flex:1;">
                    <label>采样器 (Sampler):</label>
                    <input type="text" id="wfm-modal-preset-sampler" class="wfm-input" value="euler_ancestral">
                </div>
                <div class="wfm-form-group" style="flex:1;">
                    <label>调度器 (Scheduler):</label>
                    <input type="text" id="wfm-modal-preset-sched" class="wfm-input" value="beta57">
                </div>
            </div>
            <div class="wfm-form-group">
                <label>包含当前激活的 LoRA (${activeLoras.length} 个):</label>
                <div style="max-height:100px;overflow-y:auto;background:var(--wfm-bg-secondary);padding:6px;border-radius:4px;font-size:11px;">
                    ${activeLoras.map(l => `<div>• ${escapeHtml(l.name)} (M:${l.model_weight} / C:${l.clip_weight})</div>`).join("")}
                </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
                <button type="button" class="wfm-btn" id="wfm-modal-preset-cancel">取消</button>
                <button type="button" class="wfm-btn wfm-btn-primary" id="wfm-modal-preset-confirm">确认保存</button>
            </div>
        </div>
    `;

    openModal("💾 保存为常用预设", content);

    document.getElementById("wfm-modal-preset-cancel")?.addEventListener("click", closeModal);
    document.getElementById("wfm-modal-preset-confirm")?.addEventListener("click", async () => {
        const name = document.getElementById("wfm-modal-preset-name")?.value.trim() || "未命名预设";
        const desc = document.getElementById("wfm-modal-preset-desc")?.value.trim() || "";
        const smode = document.querySelector("input[name='wfm-modal-preset-smode']:checked")?.value || "single";
        const steps = parseInt(document.getElementById("wfm-modal-preset-steps")?.value || "12", 10);
        const cfg = parseFloat(document.getElementById("wfm-modal-preset-cfg")?.value || "1.6");
        const sampler = document.getElementById("wfm-modal-preset-sampler")?.value.trim() || "euler_ancestral";
        const sched = document.getElementById("wfm-modal-preset-sched")?.value.trim() || "beta57";

        const newPreset = {
            id: `custom-${Date.now()}`,
            name,
            description: desc,
            sampling_mode: smode,
            sampler_settings: {
                steps,
                cfg,
                sampler_name: sampler,
                scheduler: sched,
                denoise: 1.0
            },
            loras: activeLoras,
            quality_prefix: "masterpiece, best quality, aesthetic, highly detailed",
            default_negative: "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits"
        };

        try {
            const res = await fetch("/api/wfm/gen_presets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(newPreset)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            showToast("预设已保存！", "success");
            closeModal();
            genPresetsState.activePresetId = newPreset.id;
            const containerEl = document.getElementById("wfm-gen-preset-mount");
            if (containerEl) {
                await initGenPresetsWidget(containerEl);
            }
        } catch (e) {
            showToast(`保存失败: ${e.message}`, "error");
        }
    });
}
