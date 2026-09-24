/**
 * Story Prompt Parsing & Multi-LoRA Auto-Match Module
 * Handles [tags]/[caption] extraction, trigger matching, tuned weight mixing, and workflow injection.
 */

import { comfyUI } from "./comfyui-client.js";
import { showToast } from "./app.js";
import { escapeHtml } from "./util.js";
import { t } from "./i18n.js";

export const storyLoraState = {
    matchedLoras: [],
    autoInject: true,
    autoTurbo: true,
    rules: [],
    currentFile: "",
};

/**
 * Initialize the Story Prompt & LoRA Auto-Match widget in the prompt tab
 */
export function initPromptStoryLora(containerEl) {
    if (!containerEl) return;

    containerEl.innerHTML = `
        <div class="wfm-story-lora-card">
            <div class="wfm-story-lora-header">
                <div class="wfm-story-lora-title">
                    <span>✨ ${t("storyLoraTitle") || "故事分镜 & 智能 LoRA 混合"}</span>
                    <span id="wfm-story-lora-file-badge" class="wfm-story-badge" style="display:none;"></span>
                </div>
                <div class="wfm-story-lora-actions">
                    <label class="wfm-btn wfm-btn-xs" style="cursor:pointer;" title="导入本地 LN*.txt 分镜文本">
                        📂 ${t("loadStoryFile") || "导入故事"}
                        <input type="file" id="wfm-story-file-input" accept=".txt" style="display:none;">
                    </label>
                    <button type="button" id="wfm-story-match-btn" class="wfm-btn wfm-btn-xs wfm-btn-primary" title="根据当前提示词重新扫描匹配 LoRA">
                        🔍 ${t("matchLorasBtn") || "匹配 LoRA"}
                    </button>
                    <button type="button" id="wfm-story-rules-btn" class="wfm-btn wfm-btn-xs" title="查看与配置 LoRA 触发词与混合权重规则">
                        ⚙️ ${t("loraRulesBtn") || "规则"}
                    </button>
                </div>
            </div>

            <!-- Matched LoRA badges list -->
            <div id="wfm-story-matched-list" class="wfm-story-matched-list">
                <div class="wfm-story-placeholder">
                    ${t("storyLoraHint") || "输入提示词或导入分镜后点击【匹配 LoRA】，将自动识别自训角色与动作 LoRA 及其混合权重"}
                </div>
            </div>

            <!-- Options bar -->
            <div class="wfm-story-lora-footer">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--wfm-text-secondary);">
                    <input type="checkbox" id="wfm-story-auto-inject" ${storyLoraState.autoInject ? "checked" : ""}>
                    ${t("autoInjectLoRA") || "生成时自动注入 LoRA 混合"}
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--wfm-text-secondary);margin-left:12px;">
                    <input type="checkbox" id="wfm-story-auto-turbo" ${storyLoraState.autoTurbo ? "checked" : ""}>
                    ${t("includeTurbo") || "包含加速 Turbo LoRA"}
                </label>
                <button type="button" id="wfm-story-apply-now-btn" class="wfm-btn wfm-btn-xs" style="margin-left:auto;">
                    ⚡ ${t("applyLorasToWf") || "立即写入工作流"}
                </button>
            </div>
        </div>
    `;

    // Event listeners
    document.getElementById("wfm-story-file-input")?.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (re) => {
            const content = re.target?.result;
            if (typeof content === "string") {
                await loadStoryContent(content, file.name);
            }
        };
        reader.readAsText(file);
    });

    document.getElementById("wfm-story-match-btn")?.addEventListener("click", () => {
        const text = document.getElementById("wfm-prompt-pos-text")?.value || "";
        matchPromptText(text);
    });

    document.getElementById("wfm-story-auto-inject")?.addEventListener("change", (e) => {
        storyLoraState.autoInject = e.target.checked;
    });

    document.getElementById("wfm-story-auto-turbo")?.addEventListener("change", (e) => {
        storyLoraState.autoTurbo = e.target.checked;
        const text = document.getElementById("wfm-prompt-pos-text")?.value || "";
        matchPromptText(text);
    });

    document.getElementById("wfm-story-apply-now-btn")?.addEventListener("click", async () => {
        if (!comfyUI.currentWorkflow) {
            showToast(t("modelsGenUINoWorkflow") || "未加载工作流", "warning");
            return;
        }
        await applyMatchedLorasToCurrentWorkflow();
    });

    document.getElementById("wfm-story-rules-btn")?.addEventListener("click", () => {
        openLoraRulesModal();
    });

    // Re-render if we already have matched loras
    if (storyLoraState.matchedLoras.length > 0) {
        renderMatchedLorasList();
    }
}

/**
 * Parse story file content and set prompt
 */
export async function loadStoryContent(content, filename = "") {
    storyLoraState.currentFile = filename;
    const badge = document.getElementById("wfm-story-lora-file-badge");
    if (badge) {
        if (filename) {
            badge.textContent = filename;
            badge.style.display = "inline-block";
        } else {
            badge.style.display = "none";
        }
    }

    try {
        const res = await fetch("/api/wfm/lora/match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: content,
                auto_turbo: storyLoraState.autoTurbo
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Update Positive Prompt textarea
        const posTextarea = document.getElementById("wfm-prompt-pos-text");
        if (posTextarea && data.parsed_prompt) {
            posTextarea.value = data.parsed_prompt.positive_prompt || data.parsed_prompt.raw || content;
            // Also update node in currentWorkflow if available
            const targetSelect = document.getElementById("wfm-prompt-pos-target");
            const nodeId = targetSelect?.value;
            if (nodeId && comfyUI.currentWorkflow?.[nodeId]) {
                const textKey = targetSelect.selectedOptions[0]?.dataset?.textKey || "text";
                comfyUI.currentWorkflow[nodeId].inputs[textKey] = posTextarea.value;
            }
        }

        // Store matched loras
        storyLoraState.matchedLoras = data.matched_loras || [];
        renderMatchedLorasList();
        showToast(`已加载分镜并匹配到 ${storyLoraState.matchedLoras.length} 个 LoRA`, "success");
    } catch (e) {
        console.error("Error matching story prompt:", e);
        showToast(`匹配失败: ${e.message}`, "error");
    }
}

/**
 * Match arbitrary prompt text
 */
export async function matchPromptText(text) {
    if (!text.trim()) {
        storyLoraState.matchedLoras = [];
        renderMatchedLorasList();
        return;
    }

    try {
        const res = await fetch("/api/wfm/lora/match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text,
                auto_turbo: storyLoraState.autoTurbo
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        storyLoraState.matchedLoras = data.matched_loras || [];
        renderMatchedLorasList();
        showToast(`检测到 ${storyLoraState.matchedLoras.length} 个激活 LoRA`, "info");
    } catch (e) {
        console.error("Match error:", e);
        showToast(`识别失败: ${e.message}`, "error");
    }
}

/**
 * Render the interactive badge list of matched LoRAs
 */
export function renderMatchedLorasList() {
    const listEl = document.getElementById("wfm-story-matched-list");
    if (!listEl) return;

    if (!storyLoraState.matchedLoras || storyLoraState.matchedLoras.length === 0) {
        listEl.innerHTML = `
            <div class="wfm-story-placeholder">
                未检测到匹配的自训 LoRA (可在规则中添加新触发词或从本地扫描)
            </div>
        `;
        return;
    }

    const categoryColors = {
        character: "#8b5cf6",
        action: "#ec4899",
        repair: "#10b981",
        turbo: "#f59e0b",
        artist: "#3b82f6",
        custom: "#6366f1",
        "auto-scanned": "#64748b"
    };

    const html = storyLoraState.matchedLoras.map((lora, idx) => {
        const catColor = categoryColors[lora.category] || "#6366f1";
        const isChecked = lora.active !== false;

        return `
            <div class="wfm-story-lora-chip ${isChecked ? "active" : "inactive"}" data-index="${idx}">
                <input type="checkbox" class="wfm-story-chip-toggle" data-index="${idx}" ${isChecked ? "checked" : ""}>
                <span class="wfm-story-chip-cat" style="background:${catColor};">${lora.category || "lora"}</span>
                <span class="wfm-story-chip-name" title="${escapeHtml(lora.path)}">${escapeHtml(lora.name)}</span>
                ${lora.trigger ? `<span class="wfm-story-chip-trigger" title="触发词">[${escapeHtml(lora.trigger)}]</span>` : ""}
                <div class="wfm-story-chip-weights">
                    <span style="font-size:10px;color:var(--wfm-text-secondary);">M:</span>
                    <input type="number" class="wfm-input wfm-story-chip-weight" data-index="${idx}" data-field="model_weight" value="${lora.model_weight}" step="0.05" min="-5" max="5">
                    <span style="font-size:10px;color:var(--wfm-text-secondary);margin-left:2px;">C:</span>
                    <input type="number" class="wfm-input wfm-story-chip-weight" data-index="${idx}" data-field="clip_weight" value="${lora.clip_weight}" step="0.05" min="-5" max="5">
                </div>
                <button type="button" class="wfm-story-chip-del" data-index="${idx}" title="移除">✕</button>
            </div>
        `;
    }).join("");

    listEl.innerHTML = html;

    // Attach chip event listeners
    listEl.querySelectorAll(".wfm-story-chip-toggle").forEach((cb) => {
        cb.addEventListener("change", (e) => {
            const idx = parseInt(e.target.dataset.index);
            if (storyLoraState.matchedLoras[idx]) {
                storyLoraState.matchedLoras[idx].active = e.target.checked;
                const chip = listEl.querySelector(`.wfm-story-lora-chip[data-index="${idx}"]`);
                chip?.classList.toggle("active", e.target.checked);
                chip?.classList.toggle("inactive", !e.target.checked);
            }
        });
    });

    listEl.querySelectorAll(".wfm-story-chip-weight").forEach((inp) => {
        inp.addEventListener("change", (e) => {
            const idx = parseInt(e.target.dataset.index);
            const field = e.target.dataset.field;
            const val = parseFloat(e.target.value);
            if (storyLoraState.matchedLoras[idx] && !isNaN(val)) {
                storyLoraState.matchedLoras[idx][field] = val;
            }
        });
    });

    listEl.querySelectorAll(".wfm-story-chip-del").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.dataset.index);
            storyLoraState.matchedLoras.splice(idx, 1);
            renderMatchedLorasList();
        });
    });
}

/**
 * Apply matched LoRAs to current workflow via backend API
 */
export async function applyMatchedLorasToCurrentWorkflow() {
    if (!comfyUI.currentWorkflow) return;

    try {
        const activeList = storyLoraState.matchedLoras.filter((l) => l.active !== false);
        const res = await fetch("/api/wfm/lora/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                workflow: comfyUI.currentWorkflow,
                active_loras: activeList
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.workflow) {
            comfyUI.currentWorkflow = data.workflow;
            // Update raw json textarea
            const rawTextarea = document.getElementById("wfm-gen-raw-json");
            if (rawTextarea) {
                rawTextarea.value = JSON.stringify(data.workflow, null, 2);
            }
            showToast(`已成功将 ${activeList.length} 个 LoRA 注入工作流`, "success");
        }
    } catch (e) {
        console.error("Apply error:", e);
        showToast(`写入工作流失败: ${e.message}`, "error");
    }
}

/**
 * Open LoRA rules modal for editing triggers, weights, and rescanning
 */
export async function openLoraRulesModal() {
    let modal = document.getElementById("wfm-story-rules-modal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "wfm-story-rules-modal";
        modal.className = "wfm-modal-backdrop";
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="wfm-modal-dialog" style="max-width:850px;max-height:85vh;display:flex;flex-direction:column;">
            <div class="wfm-modal-header">
                <h3>⚙️ ${t("loraRulesConfig") || "LoRA 触发规则与微调混合管理"}</h3>
                <button type="button" class="wfm-modal-close-btn" id="wfm-story-rules-close">✕</button>
            </div>
            <div class="wfm-modal-toolbar" style="display:flex;gap:8px;padding:8px 16px;background:var(--wfm-surface-2);border-bottom:1px solid var(--wfm-border);align-items:center;">
                <input type="text" id="wfm-story-rules-search" class="wfm-input" placeholder="搜索规则或模型..." style="flex:1;">
                <button type="button" id="wfm-story-rules-rescan-btn" class="wfm-btn wfm-btn-sm" title="从 models/loras 目录重新扫描所有 .trigger.txt">
                    🔄 ${t("rescanTriggersBtn") || "重新扫描本地 .trigger.txt"}
                </button>
                <button type="button" id="wfm-story-rules-add-btn" class="wfm-btn wfm-btn-sm wfm-btn-primary">
                    + ${t("addRuleBtn") || "添加规则"}
                </button>
            </div>
            <div class="wfm-modal-body" style="flex:1;overflow-y:auto;padding:12px 16px;">
                <div id="wfm-story-rules-table-container">加载中...</div>
            </div>
            <div class="wfm-modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--wfm-border);">
                <button type="button" class="wfm-btn" id="wfm-story-rules-cancel">${t("cancel") || "取消"}</button>
                <button type="button" class="wfm-btn wfm-btn-primary" id="wfm-story-rules-save">${t("saveRules") || "保存规则"}</button>
            </div>
        </div>
    `;

    modal.style.display = "flex";

    // Load rules
    let currentRules = [];
    try {
        const res = await fetch("/api/wfm/lora/rules");
        currentRules = res.ok ? await res.json() : [];
    } catch {
        currentRules = [];
    }

    const renderTable = (rulesToRender) => {
        const container = document.getElementById("wfm-story-rules-table-container");
        if (!container) return;

        const html = `
            <table class="wfm-table" style="width:100%;font-size:12px;">
                <thead>
                    <tr>
                        <th style="width:140px;">名称</th>
                        <th>LoRA 路径 (相对 models/loras)</th>
                        <th style="width:160px;">触发关键词 (逗号分隔)</th>
                        <th style="width:70px;">模型权重</th>
                        <th style="width:70px;">Clip权重</th>
                        <th style="width:40px;"></th>
                    </tr>
                </thead>
                <tbody>
                    ${rulesToRender.map((r, i) => `
                        <tr data-rule-idx="${i}">
                            <td><input type="text" class="wfm-input wfm-rule-name" value="${escapeHtml(r.name || "")}" style="width:100%;"></td>
                            <td><input type="text" class="wfm-input wfm-rule-path" value="${escapeHtml(r.path || "")}" style="width:100%;"></td>
                            <td><input type="text" class="wfm-input wfm-rule-triggers" value="${escapeHtml((r.triggers || []).join(", "))}" style="width:100%;"></td>
                            <td><input type="number" class="wfm-input wfm-rule-mw" value="${r.model_weight ?? 1.0}" step="0.05" style="width:100%;"></td>
                            <td><input type="number" class="wfm-input wfm-rule-cw" value="${r.clip_weight ?? 1.0}" step="0.05" style="width:100%;"></td>
                            <td><button type="button" class="wfm-btn wfm-btn-xs wfm-btn-danger wfm-rule-del-btn" data-rule-idx="${i}">✕</button></td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        `;
        container.innerHTML = html;

        // Delete buttons
        container.querySelectorAll(".wfm-rule-del-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                const idx = parseInt(e.target.dataset.ruleIdx);
                currentRules.splice(idx, 1);
                renderTable(currentRules);
            });
        });
    };

    renderTable(currentRules);

    // Search filter
    document.getElementById("wfm-story-rules-search")?.addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase();
        const filtered = currentRules.filter((r) =>
            (r.name || "").toLowerCase().includes(q) ||
            (r.path || "").toLowerCase().includes(q) ||
            (r.triggers || []).some((tr) => tr.toLowerCase().includes(q))
        );
        renderTable(filtered);
    });

    // Add rule
    document.getElementById("wfm-story-rules-add-btn")?.addEventListener("click", () => {
        currentRules.unshift({
            name: "新规则",
            path: "",
            triggers: [],
            model_weight: 1.0,
            clip_weight: 1.0,
            category: "custom"
        });
        renderTable(currentRules);
    });

    // Rescan button
    document.getElementById("wfm-story-rules-rescan-btn")?.addEventListener("click", async () => {
        try {
            showToast("正在扫描 models/loras 目录...", "info");
            const res = await fetch("/api/wfm/lora/rules/rescan", { method: "POST" });
            const data = await res.json();
            showToast(data.message || "扫描完成", "success");
            // Reload rules
            const rRes = await fetch("/api/wfm/lora/rules");
            currentRules = rRes.ok ? await rRes.json() : currentRules;
            renderTable(currentRules);
        } catch (e) {
            showToast(`扫描失败: ${e.message}`, "error");
        }
    });

    // Save rules
    document.getElementById("wfm-story-rules-save")?.addEventListener("click", async () => {
        // Collect rows
        const rows = modal.querySelectorAll("tbody tr");
        const newRules = [];
        rows.forEach((row) => {
            const name = row.querySelector(".wfm-rule-name")?.value.trim() || "";
            const path = row.querySelector(".wfm-rule-path")?.value.trim() || "";
            const trigsStr = row.querySelector(".wfm-rule-triggers")?.value || "";
            const mw = parseFloat(row.querySelector(".wfm-rule-mw")?.value) || 1.0;
            const cw = parseFloat(row.querySelector(".wfm-rule-cw")?.value) || 1.0;
            const triggers = trigsStr.split(",").map((s) => s.trim()).filter(Boolean);

            if (path) {
                newRules.push({
                    name: name || path,
                    path,
                    triggers,
                    model_weight: mw,
                    clip_weight: cw,
                    category: "custom"
                });
            }
        });

        try {
            const res = await fetch("/api/wfm/lora/rules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(newRules)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            showToast("规则保存成功！", "success");
            modal.style.display = "none";
        } catch (e) {
            showToast(`保存失败: ${e.message}`, "error");
        }
    });

    // Close
    const closeModal = () => { modal.style.display = "none"; };
    document.getElementById("wfm-story-rules-close")?.addEventListener("click", closeModal);
    document.getElementById("wfm-story-rules-cancel")?.addEventListener("click", closeModal);
}
