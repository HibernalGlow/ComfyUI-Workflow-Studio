/**
 * Workflow Studio - Artists & Styles Gallery Tab (Vanilla Old UI)
 * Provides visual artist & LoRA browsing, preview inspection, category filtering, and TOML snippet generation.
 */

import { showToast, openModal } from "./app.js";
import { escapeHtml } from "./util.js";

let artistsData = [];
let filteredArtists = [];
let currentSearch = "";
let currentCategory = "all";
let currentArch = "all";
let currentGroup = "all";
let onlyWithPreview = false; // 默认展示全量 LoRA，带图置顶
let fitMode = localStorage.getItem("wfm_artists_fit_mode") || "contain";
let manageMode = false;
let selectedIds = new Set();
let subdirsCache = [];

const CATEGORIES = [
    { id: "all", label: "全部 LoRA", icon: "🌐" },
    { id: "artist", label: "画师风格", icon: "🎨" },
    { id: "chara", label: "角色", icon: "🎭" },
    { id: "action", label: "动作姿态", icon: "🏃" },
    { id: "outfit", label: "服饰换装", icon: "👗" },
    { id: "enhancer", label: "美学加速", icon: "✨" },
    { id: "repair", label: "微调修复", icon: "🛠️" },
    { id: "other", label: "其他", icon: "📦" },
];

function detectCategoryFromPath(low) {
    if (low.includes("/artist") || low.includes("artist") || low.includes("style")) {
        return { cat: "artist", label: "画师风格" };
    }
    if (low.includes("/chara") || low.includes("chara") || low.includes("character")) {
        return { cat: "chara", label: "角色" };
    }
    if (low.includes("/action") || low.includes("action") || low.includes("play") || low.includes("foot") || low.includes("pose") || low.includes("cerpe")) {
        return { cat: "action", label: "动作姿态" };
    }
    if (low.includes("/outfit") || low.includes("outfit") || low.includes("clothes") || low.includes("dress") || low.includes("costume")) {
        return { cat: "outfit", label: "服饰换装" };
    }
    if (low.includes("/turbo") || low.includes("turbo") || low.includes("/beauty") || low.includes("aesthetic")) {
        return { cat: "enhancer", label: "美学加速" };
    }
    if (low.includes("/repair") || low.includes("repair") || low.includes("slider")) {
        return { cat: "repair", label: "微调修复" };
    }
    return { cat: "other", label: "其他" };
}

function cleanDisplayName(stem, cat) {
    const low = stem.toLowerCase();
    if (low.includes("atdan")) return "Atdan (阿特丹)";
    if (low.includes("freng")) return "Freng";
    if (low.includes("oyari_ashito")) return "Oyari Ashito (reweik)";
    if (low.includes("bubutuke")) return "Bubutuke (布布杜克)";
    if (low.includes("villainchin")) return "Villainchin";
    if (low.includes("imazawa")) return "Imazawa";
    if (low.includes("nnmbpx")) return "NNMBPX";
    if (low.includes("scallionflavor")) return "Scallionflavor";
    if (low.includes("chen-bin") || low.includes("chenbin")) return "Chen-Bin";
    if (low.includes("pija")) return "Pija (pianiishimo)";
    if (low.includes("jima")) return "JIMA";
    if (low.includes("kaede_sayappa")) return "さやっぱ (sayappa) 楓 kaede";
    if (low.includes("laffey")) return "拉菲 (Laffey)";
    if (low.includes("typhoeus")) return "提丰 (Typhoeus)";
    if (low.includes("rossi")) return "洛茜 (Rossi)";
    if (low.includes("niannian")) return "念念 (Niannian)";
    if (low.includes("ankasha") || low.includes("ankaxiya")) return "安卡希雅 (Ankasha)";
    if (low.includes("ustirrup")) return "镫袜足交 (Ustirrup)";
    if (low.includes("stirrup")) return "镫袜 (Stirrup)";
    if (low.includes("turbo")) return "Turbo 极速加速";
    if (low.includes("aesthetic")) return "Aesthetic 美学提升";

    let name = stem.replace(/^(style[-_]|anima[-_]|illus[-_]|@)/i, "");
    name = name.replace(/[-_](anima|illus|lora|v\d+.*|epoch\d+.*|step\d+.*|\d{6}.*)$/i, "");
    name = name.replace(/@.*$/, "");
    name = name.replace(/[_]/g, " ").replace(/[-]/g, " ").trim();
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : stem;
}

export async function initArtistsTab() {
    const container = document.getElementById("wfm-tab-artists");
    if (!container) return;

    container.innerHTML = `
        <div class="wfm-toolbar" style="display:flex; flex-direction:column; gap:10px; padding:12px 16px; border-bottom:1px solid var(--wfm-border, #333);">
            <!-- Row 1: Search & dropdowns & action buttons -->
            <div class="wfm-toolbar-row" style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    <div class="wfm-search-wrap" style="width:280px; position:relative;">
                        <input type="text" id="wfm-artists-search" class="wfm-search-input" placeholder="搜索画师/角色/触发词/文件...">
                        <button class="wfm-search-clear-btn" id="wfm-artists-search-clear" title="清空搜索" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); background:none; border:none; color:#888; cursor:pointer;">✕</button>
                    </div>
                    <select id="wfm-artists-arch-filter" class="wfm-select wfm-toolbar-select">
                        <option value="all">全部架构 (All Arch)</option>
                        <option value="anima">Anima (动漫推荐)</option>
                        <option value="illustrious">Illustrious</option>
                        <option value="flux">Flux / Klein</option>
                        <option value="other">其他</option>
                    </select>
                    <select id="wfm-artists-group-filter" class="wfm-select wfm-toolbar-select">
                        <option value="all">全部分组 (All Groups)</option>
                        <option value="260924 精选">260924 最新精选</option>
                        <option value="自训 (Self)">自训 (Self)</option>
                        <option value="碧蓝航线">碧蓝航线</option>
                        <option value="终末地">终末地</option>
                        <option value="尘白禁区">尘白禁区</option>
                        <option value="LyCORIS">LyCORIS</option>
                    </select>
                    <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; color:var(--wfm-text, #ccc); user-select:none; margin-left:4px;">
                        <input type="checkbox" id="wfm-artists-preview-only">
                        <span>仅看有预览图</span>
                    </label>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <span id="wfm-artists-stats" style="font-size:12px; color:var(--wfm-text-secondary, #888);">加载中...</span>
                    <button class="wfm-btn wfm-btn-sm" id="wfm-artists-manage-btn">${manageMode ? "退出管理" : "☑ 批量管理"}</button>
                    <button class="wfm-btn wfm-btn-sm" id="wfm-artists-fit-toggle" title="切换图片自适应显示模式：完整自适应（包含背景氛围光晕）或裁剪铺满">${fitMode === "contain" ? "🖼️ 完整自适应" : "📐 裁切铺满"}</button>
                    <button class="wfm-btn wfm-btn-sm" id="wfm-artists-refresh-btn">🔄 刷新</button>
                    <button class="wfm-btn wfm-btn-sm wfm-btn-primary" id="wfm-artists-to-newui-btn" title="在新版 MD3 界面中打开画师与LoRA库">✨ 切换新版画廊</button>
                </div>
            </div>

            <!-- Row 2: Category Chips / Filter Buttons -->
            <div id="wfm-artists-categories-bar" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                <!-- Injected dynamically -->
            </div>

            <!-- Row 3: Batch Actions Bar -->
            <div id="wfm-artists-batch-bar" style="display:${manageMode ? 'flex' : 'none'}; gap:12px; align-items:center; background:var(--wfm-card-bg, #222); padding:8px 12px; border-radius:6px; margin-top:2px; border:1px solid var(--wfm-border, #444);">
                <span id="wfm-artists-selected-count" style="font-size:12px; color:var(--wfm-text, #eee); font-weight:600;">已选中 0 项</span>
                <button type="button" class="wfm-btn wfm-btn-xs" id="wfm-artists-select-all-btn">全选当前筛选</button>
                <div style="margin-left:auto; display:flex; gap:8px;">
                    <button type="button" class="wfm-btn wfm-btn-xs" id="wfm-artists-batch-move-btn">📁 批量移动</button>
                    <button type="button" class="wfm-btn wfm-btn-xs" id="wfm-artists-batch-delete-btn" style="color:#ef4444; border-color:#ef4444;">🗑️ 批量删除</button>
                </div>
            </div>
        </div>

        <div id="wfm-artists-grid" style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 16px;
            padding: 16px;
            overflow-y: auto;
            max-height: calc(100vh - 165px);
        "></div>
    `;

    // Event listeners
    function updateBatchBar() {
        const countEl = document.getElementById("wfm-artists-selected-count");
        if (countEl) countEl.textContent = `已选中 ${selectedIds.size} / ${filteredArtists.length} 项`;
        const moveBtn = document.getElementById("wfm-artists-batch-move-btn");
        if (moveBtn) moveBtn.disabled = selectedIds.size === 0;
        const delBtn = document.getElementById("wfm-artists-batch-delete-btn");
        if (delBtn) delBtn.disabled = selectedIds.size === 0;
    }

    document.getElementById("wfm-artists-manage-btn")?.addEventListener("click", () => {
        manageMode = !manageMode;
        selectedIds.clear();
        const btn = document.getElementById("wfm-artists-manage-btn");
        if (btn) btn.textContent = manageMode ? "退出管理" : "☑ 批量管理";
        const bar = document.getElementById("wfm-artists-batch-bar");
        if (bar) bar.style.display = manageMode ? "flex" : "none";
        updateBatchBar();
        renderGrid();
    });

    document.getElementById("wfm-artists-select-all-btn")?.addEventListener("click", () => {
        if (selectedIds.size === filteredArtists.length) {
            selectedIds.clear();
        } else {
            selectedIds = new Set(filteredArtists.map((a) => a.rel_path));
        }
        updateBatchBar();
        renderGrid();
    });

    document.getElementById("wfm-artists-batch-move-btn")?.addEventListener("click", () => {
        const targets = artistsData.filter((a) => selectedIds.has(a.rel_path));
        moveArtists(targets);
    });

    document.getElementById("wfm-artists-batch-delete-btn")?.addEventListener("click", () => {
        const targets = artistsData.filter((a) => selectedIds.has(a.rel_path));
        deleteArtists(targets);
    });

    document.getElementById("wfm-artists-fit-toggle")?.addEventListener("click", () => {
        fitMode = fitMode === "contain" ? "cover" : "contain";
        try { localStorage.setItem("wfm_artists_fit_mode", fitMode); } catch {}
        const btn = document.getElementById("wfm-artists-fit-toggle");
        if (btn) btn.textContent = fitMode === "contain" ? "🖼️ 完整自适应" : "📐 裁切铺满";
        renderGrid();
    });

    document.getElementById("wfm-artists-search")?.addEventListener("input", (e) => {
        currentSearch = e.target.value.trim().toLowerCase();
        applyFilterAndRender();
    });

    document.getElementById("wfm-artists-search-clear")?.addEventListener("click", () => {
        const inp = document.getElementById("wfm-artists-search");
        if (inp) inp.value = "";
        currentSearch = "";
        applyFilterAndRender();
    });

    document.getElementById("wfm-artists-arch-filter")?.addEventListener("change", (e) => {
        currentArch = e.target.value;
        applyFilterAndRender();
    });

    document.getElementById("wfm-artists-group-filter")?.addEventListener("change", (e) => {
        currentGroup = e.target.value;
        applyFilterAndRender();
    });

    document.getElementById("wfm-artists-preview-only")?.addEventListener("change", (e) => {
        onlyWithPreview = e.target.checked;
        applyFilterAndRender();
    });

    document.getElementById("wfm-artists-refresh-btn")?.addEventListener("click", () => {
        loadArtistsData(true);
    });

    document.getElementById("wfm-artists-to-newui-btn")?.addEventListener("click", () => {
        window.open("/wfm_static/newui.html#/artists", "_blank");
    });

    // Initial load
    await loadArtistsData(false);
}

function renderCategoryChips() {
    const bar = document.getElementById("wfm-artists-categories-bar");
    if (!bar) return;

    // Count per category
    const counts = {};
    for (const cat of CATEGORIES) {
        counts[cat.id] = 0;
    }
    for (const a of artistsData) {
        counts["all"] = (counts["all"] || 0) + 1;
        const catKey = a.category || "other";
        counts[catKey] = (counts[catKey] || 0) + 1;
    }

    bar.innerHTML = CATEGORIES.map((cat) => {
        const isActive = currentCategory === cat.id;
        const count = counts[cat.id] || 0;
        const activeStyle = isActive
            ? "background: var(--wfm-accent, #3b82f6); color: #fff; border-color: var(--wfm-accent, #3b82f6); font-weight: 600;"
            : "background: var(--wfm-card-bg, #222); color: var(--wfm-text, #ccc); border-color: var(--wfm-border, #444);";

        return `
            <button class="wfm-cat-chip" data-cat="${cat.id}" style="
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 4px 10px;
                border-radius: 16px;
                border: 1px solid;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.15s ease;
                user-select: none;
                ${activeStyle}
            ">
                <span>${cat.icon}</span>
                <span>${cat.label}</span>
                <span style="opacity: 0.75; font-size: 11px;">(${count})</span>
            </button>
        `;
    }).join("");

    bar.querySelectorAll(".wfm-cat-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
            currentCategory = btn.dataset.cat;
            renderCategoryChips();
            applyFilterAndRender();
        });
    });
}

const CACHE_STORAGE_KEY = "wfm_artists_cache_v2";
const CACHE_TTL_MS = 3 * 60 * 1000;
let cacheTimestamp = 0;

async function loadArtistsData(forceRefresh = false) {
    const statsEl = document.getElementById("wfm-artists-stats");

    // 1. In-memory cache hit
    if (!forceRefresh && artistsData && artistsData.length > 0 && (Date.now() - cacheTimestamp < CACHE_TTL_MS)) {
        renderCategoryChips();
        applyFilterAndRender();
        return;
    }

    // 2. SessionStorage cache hit
    if (!forceRefresh && (!artistsData || artistsData.length === 0)) {
        try {
            const raw = sessionStorage.getItem(CACHE_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed.artists) && parsed.artists.length > 0) {
                    artistsData = parsed.artists;
                    cacheTimestamp = parsed.timestamp || Date.now();
                    renderCategoryChips();
                    applyFilterAndRender();
                    if (Date.now() - cacheTimestamp < CACHE_TTL_MS) {
                        return; // Cache is fully fresh, 0ms return!
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    if (statsEl) statsEl.textContent = "正在扫描全库 LoRA...";

    try {
        const url = `/api/wfm/artists${forceRefresh ? "?refresh=true" : ""}`;
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            if (data.artists && Array.isArray(data.artists) && data.artists.length > 50) {
                artistsData = data.artists;
                cacheTimestamp = Date.now();
                try {
                    sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ timestamp: cacheTimestamp, artists: data.artists }));
                } catch {}
                renderCategoryChips();
                applyFilterAndRender();
                if (forceRefresh) showToast(`已刷新并加载 ${data.artists.length} 个 LoRA`, "success");
                return;
            }
        }
    } catch {
        // Fall through to fallback
    }

    // Fallback: Fetch all LoRAs from ComfyUI
    try {
        const resp = await fetch("/api/wfm/models/files?type=lora");
        if (resp.ok) {
            const files = await resp.json();

            // Incremental check: if files count and paths match existing cache, don't re-parse!
            if (artistsData && artistsData.length > 0 && !forceRefresh) {
                const currentPaths = new Set(artistsData.map((a) => a.rel_path));
                const isSame = files.length === artistsData.length && files.every((f) => currentPaths.has(f.replace(/\\/g, "/")));
                if (isSame) {
                    cacheTimestamp = Date.now();
                    return;
                }
            }

            const list = [];
            for (const f of files) {
                const rel_path = f.replace(/\\/g, "/");
                const win_path = f.replace(/\//g, "\\");
                const low = rel_path.toLowerCase();
                const filename = rel_path.split("/").pop() || rel_path;
                const stem = filename.replace(/\.[^/.]+$/, "");

                const { cat, label } = detectCategoryFromPath(low);
                const display_name = cleanDisplayName(stem, cat);
                const arch = low.includes("anima") ? "anima" : low.includes("illus") ? "illustrious" : low.includes("2real") || low.includes("flux") ? "flux" : "other";

                let group = "通用";
                if (low.includes("260924")) group = "260924 精选";
                else if (low.includes("self")) group = "自训 (Self)";
                else if (low.includes("2606") || low.includes("2607")) group = "2606/2607 库";
                else if (low.includes("azurlane")) group = "碧蓝航线";
                else if (low.includes("endfield")) group = "终末地";
                else if (low.includes("snowbreak")) group = "尘白禁区";
                else if (low.includes("lycoris")) group = "LyCORIS";

                const has_preview = low.includes("260924") || low.includes(".preview") || low.includes("atdan") || low.includes("freng") || low.includes("bubble") || low.includes("laffey") || low.includes("niannian") || low.includes("typhoeus") || low.includes("ankasha");
                const preview_url = `/api/wfm/models/preview?type=lora&name=${encodeURIComponent(rel_path)}`;
                const is_notrigger = low.includes("notrigger") || stem.includes("Oyari") || stem.includes("Pija") || stem.includes("sayappa");

                const triggers = [];
                if (stem.includes("@")) {
                    const m = stem.match(/@([a-zA-Z0-9_\-]+)/);
                    if (m) triggers.push(`@${m[1]}`);
                }

                const weight_hint = low.includes("turbo") ? 0.8 : low.includes("aesthetic") ? 0.48 : 0.8;
                const toml_snippet = `  # ${label}：${display_name}${is_notrigger ? " (无触发词)" : ""}\n  [[base.loras]]\n  name         = "${display_name}"\n  path         = '${win_path}'\n  model_weight = ${weight_hint}\n  clip_weight  = 1.0`;

                list.push({
                    id: rel_path,
                    filename,
                    rel_path,
                    win_path,
                    stem,
                    display_name,
                    category: cat,
                    category_label: label,
                    arch,
                    group,
                    has_preview,
                    preview_url,
                    is_notrigger,
                    triggers,
                    weight_hint,
                    toml_snippet,
                    info_text: "",
                });
            }

            // Sort: previews first, then 260924, then alphabet
            list.sort((a, b) => {
                if (a.has_preview !== b.has_preview) return a.has_preview ? -1 : 1;
                if (a.group.includes("260924") !== b.group.includes("260924")) {
                    return a.group.includes("260924") ? -1 : 1;
                }
                return a.display_name.localeCompare(b.display_name);
            });

            artistsData = list;
            cacheTimestamp = Date.now();
            try {
                sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ timestamp: cacheTimestamp, artists: list }));
            } catch {}
            renderCategoryChips();
            applyFilterAndRender();
            if (forceRefresh) showToast(`已刷新并加载 ${list.length} 个 LoRA`, "success");
        }
    } catch (e) {
        if (statsEl) statsEl.textContent = "加载失败";
        showToast("LoRA 库加载失败，请检查网络", "error");
    }
}

function applyFilterAndRender() {
    filteredArtists = artistsData.filter((a) => {
        if (onlyWithPreview && !a.has_preview) return false;
        if (currentCategory !== "all" && a.category !== currentCategory) return false;
        if (currentArch !== "all" && a.arch.toLowerCase() !== currentArch) return false;
        if (currentGroup !== "all" && !a.group.includes(currentGroup.replace(/ \(.*/, ""))) return false;
        if (currentSearch) {
            const matchName = (a.display_name || "").toLowerCase().includes(currentSearch);
            const matchPath = (a.rel_path || "").toLowerCase().includes(currentSearch);
            const matchTrig = (a.triggers || []).some((t) => t.toLowerCase().includes(currentSearch));
            const matchCat = (a.category_label || "").toLowerCase().includes(currentSearch);
            if (!matchName && !matchPath && !matchTrig && !matchCat) return false;
        }
        return true;
    });

    const statsEl = document.getElementById("wfm-artists-stats");
    const withPrevCount = artistsData.filter((a) => a.has_preview).length;
    if (statsEl) {
        statsEl.textContent = `显示 ${filteredArtists.length} / ${artistsData.length} 个 LoRA (${withPrevCount} 个带图)`;
    }

    renderGrid();
}

function renderGrid() {
    const gridEl = document.getElementById("wfm-artists-grid");
    if (!gridEl) return;

    if (filteredArtists.length === 0) {
        gridEl.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--wfm-text-secondary, #888);">
                <div style="font-size: 36px; margin-bottom: 8px;">🎨</div>
                <div style="font-size: 15px;">未找到匹配的模型</div>
                <div style="font-size: 12px; margin-top: 6px; color:#666;">可以尝试取消“仅看有预览图”或清空搜索关键词</div>
            </div>
        `;
        return;
    }

    gridEl.innerHTML = filteredArtists.map((a, idx) => {
        const previewSrc = a.has_preview && a.preview_url ? a.preview_url : "";
        const triggerBadge = a.is_notrigger
            ? `<span style="background: rgba(34,197,94,0.15); color: #22c55e; padding: 2px 6px; border-radius: 4px; font-size: 11px;">✓ 无需触发词</span>`
            : a.triggers && a.triggers.length > 0
                ? `<span style="background: var(--wfm-tag-bg, #2a2a2a); color: var(--wfm-accent, #3b82f6); padding: 2px 6px; border-radius: 4px; font-size: 11px;" title="触发词: ${escapeHtml(a.triggers.join(', '))}">@${escapeHtml(a.triggers[0].replace(/^@/, ''))}</span>`
                : `<span style="color: #666; font-size: 11px;">默认生效</span>`;

        const catIcon = a.category === "artist" ? "🎨" :
                        a.category === "chara" ? "🎭" :
                        a.category === "action" ? "🏃" :
                        a.category === "outfit" ? "👗" :
                        a.category === "enhancer" ? "✨" :
                        a.category === "repair" ? "🛠️" : "📦";

        const isSelected = selectedIds.has(a.rel_path);

        return `
            <div class="wfm-artist-card" data-idx="${idx}" style="
                background: var(--wfm-card-bg, #1e1e1e);
                border: ${isSelected ? "2px solid var(--wfm-accent, #3b82f6)" : "1px solid var(--wfm-border, #333)"};
                border-radius: 8px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                transition: transform 0.15s, border-color 0.15s;
                position: relative;
            ">
                <div class="wfm-artist-thumb-wrap" data-idx="${idx}" style="
                    position: relative;
                    width: 100%;
                    height: 240px;
                    background: #0d0d0d;
                    cursor: ${manageMode ? "pointer" : previewSrc ? "zoom-in" : "default"};
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">
                    ${manageMode ? `
                        <div style="position: absolute; top: 6px; left: 6px; z-index: 10; background: rgba(0,0,0,0.65); padding: 2px 4px; border-radius: 4px;">
                            <input type="checkbox" class="wfm-artist-card-checkbox" data-idx="${idx}" ${isSelected ? "checked" : ""} style="cursor: pointer; width: 16px; height: 16px;">
                        </div>
                    ` : ""}

                    ${previewSrc ? `
                        ${fitMode === "contain" ? `
                            <img src="${escapeHtml(previewSrc)}" aria-hidden="true" style="
                                position: absolute;
                                inset: -15%;
                                width: 130%;
                                height: 130%;
                                object-fit: cover;
                                filter: blur(20px) brightness(0.35) saturate(1.2);
                                pointer-events: none;
                                user-select: none;
                            ">
                        ` : ""}
                        <img src="${escapeHtml(previewSrc)}" alt="${escapeHtml(a.display_name)}" loading="lazy" style="
                            position: ${fitMode === "contain" ? "relative" : "absolute"};
                            top: ${fitMode === "contain" ? "auto" : "0"};
                            left: ${fitMode === "contain" ? "auto" : "0"};
                            width: 100%;
                            height: 100%;
                            object-fit: ${fitMode};
                            z-index: 1;
                        " onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <div style="display:none; position:absolute; inset:0; align-items:center; justify-content:center; color:#666; font-size:12px; z-index:2;">无预览图</div>
                    ` : `
                        <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#666; font-size:12px;">
                            <span style="font-size:26px;margin-bottom:4px;">${catIcon}</span>
                            <span>无预览图</span>
                        </div>
                    `}
                    <div style="position: absolute; top: 6px; left: ${manageMode ? "36px" : "6px"}; display: flex; gap: 4px; z-index: 2;">
                        <span style="background: rgba(0,0,0,0.75); color: #fff; font-size: 10px; padding: 2px 5px; border-radius: 3px; font-weight: 600;">
                            ${escapeHtml(a.arch.toUpperCase())}
                        </span>
                        <span style="background: rgba(0,0,0,0.75); color: #60a5fa; font-size: 10px; padding: 2px 5px; border-radius: 3px;">
                            ${catIcon} ${escapeHtml(a.category_label || a.category || "LoRA")}
                        </span>
                    </div>
                    <div style="position: absolute; top: 6px; right: 6px; z-index: 2;">
                        <span style="background: rgba(0,0,0,0.75); color: #aaa; font-size: 10px; padding: 2px 5px; border-radius: 3px;">
                            ${escapeHtml(a.group)}
                        </span>
                    </div>
                </div>

                <div style="padding: 10px 12px; display: flex; flex-direction: column; flex: 1;">
                    <div style="font-size: 14px; font-weight: 600; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--wfm-text, #eee);" title="${escapeHtml(a.display_name)}">
                        ${escapeHtml(a.display_name)}
                    </div>
                    <div style="margin-bottom: 8px;">
                        ${triggerBadge}
                    </div>
                    <div style="font-size: 11px; color: var(--wfm-text-secondary, #777); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px;" title="${escapeHtml(a.win_path)}">
                        ${escapeHtml(a.filename)}
                    </div>

                    <!-- Row 1: Copy & Apply -->
                    <div style="margin-top: auto; display: flex; gap: 6px;">
                        <button type="button" class="wfm-btn wfm-btn-xs wfm-btn-copy-toml" data-idx="${idx}" style="flex: 1;" title="复制可直接贴入 batch.toml 的完整配置">
                            📋 复制 TOML
                        </button>
                        <button type="button" class="wfm-btn wfm-btn-xs wfm-btn-copy-path" data-idx="${idx}" title="复制 Windows 端文件路径">
                            路径
                        </button>
                        <button type="button" class="wfm-btn wfm-btn-xs wfm-btn-apply" data-idx="${idx}" style="color: var(--wfm-accent, #3b82f6);" title="一键写入拉菲II batch.toml">
                            ⚡ 应用
                        </button>
                    </div>

                    <!-- Row 2: Management (Rename, Move, Delete) -->
                    <div style="display: flex; gap: 4px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--wfm-border, #333);">
                        <button type="button" class="wfm-btn wfm-btn-xs wfm-btn-rename" data-idx="${idx}" style="flex: 1;" title="重命名模型及关联文件">
                            ✏️ 改名
                        </button>
                        <button type="button" class="wfm-btn wfm-btn-xs wfm-btn-move" data-idx="${idx}" style="flex: 1;" title="移动到子目录">
                            📁 移动
                        </button>
                        <button type="button" class="wfm-btn wfm-btn-xs wfm-btn-delete" data-idx="${idx}" style="flex: 1; color: #ef4444;" title="彻底删除模型及关联文件">
                            🗑️ 删除
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    // Wire clicks
    gridEl.querySelectorAll(".wfm-artist-thumb-wrap").forEach((el) => {
        el.addEventListener("click", () => {
            const idx = Number(el.dataset.idx);
            const artist = filteredArtists[idx];
            if (!artist) return;
            if (manageMode) {
                if (selectedIds.has(artist.rel_path)) selectedIds.delete(artist.rel_path);
                else selectedIds.add(artist.rel_path);
                const countEl = document.getElementById("wfm-artists-selected-count");
                if (countEl) countEl.textContent = `已选中 ${selectedIds.size} / ${filteredArtists.length} 项`;
                renderGrid();
            } else {
                showArtistDetailModal(artist);
            }
        });
    });

    gridEl.querySelectorAll(".wfm-artist-card-checkbox").forEach((chk) => {
        chk.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = Number(chk.dataset.idx);
            const artist = filteredArtists[idx];
            if (!artist) return;
            if (chk.checked) selectedIds.add(artist.rel_path);
            else selectedIds.delete(artist.rel_path);
            const countEl = document.getElementById("wfm-artists-selected-count");
            if (countEl) countEl.textContent = `已选中 ${selectedIds.size} / ${filteredArtists.length} 项`;
            renderGrid();
        });
    });

    gridEl.querySelectorAll(".wfm-btn-copy-toml").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = Number(btn.dataset.idx);
            const artist = filteredArtists[idx];
            if (artist) {
                navigator.clipboard.writeText(artist.toml_snippet);
                showToast(`已复制 ${artist.display_name} 的 TOML 配置`, "success");
            }
        });
    });

    gridEl.querySelectorAll(".wfm-btn-copy-path").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = Number(btn.dataset.idx);
            const artist = filteredArtists[idx];
            if (artist) {
                navigator.clipboard.writeText(artist.win_path);
                showToast(`已复制路径: ${artist.win_path}`, "success");
            }
        });
    });

    gridEl.querySelectorAll(".wfm-btn-apply").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const idx = Number(btn.dataset.idx);
            const artist = filteredArtists[idx];
            if (!artist) return;

            btn.textContent = "应用中...";
            try {
                const resp = await fetch("/api/wfm/artists/apply-to-batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        toml_path: "碧蓝航线_拉菲II",
                        artist_path: artist.win_path,
                        name: artist.display_name,
                        model_weight: artist.weight_hint || 0.8,
                        clip_weight: 1.0,
                    }),
                });
                if (resp.ok) {
                    showToast(`✅ 已将【${artist.display_name}】写入拉菲II batch.toml`, "success");
                } else {
                    navigator.clipboard.writeText(artist.toml_snippet);
                    showToast("应用失败，已为您复制 TOML 片段", "info");
                }
            } catch {
                navigator.clipboard.writeText(artist.toml_snippet);
                showToast("网络请求超时，已为您复制 TOML 片段", "info");
            } finally {
                btn.textContent = "⚡ 应用";
            }
        });
    });

    gridEl.querySelectorAll(".wfm-btn-rename").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = Number(btn.dataset.idx);
            const artist = filteredArtists[idx];
            if (artist) renameArtist(artist);
        });
    });

    gridEl.querySelectorAll(".wfm-btn-move").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = Number(btn.dataset.idx);
            const artist = filteredArtists[idx];
            if (artist) moveArtists([artist]);
        });
    });

    gridEl.querySelectorAll(".wfm-btn-delete").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = Number(btn.dataset.idx);
            const artist = filteredArtists[idx];
            if (artist) deleteArtists([artist]);
        });
    });
}

async function renameArtist(artist) {
    const newName = prompt(`请输入新模型文件名（将同步重命名预览图与触发词文本）：`, artist.filename);
    if (!newName || newName.trim() === "" || newName.trim() === artist.filename) return;

    try {
        const resp = await fetch("/api/wfm/models/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model_type: "lora",
                old_name: artist.rel_path,
                new_name: newName.trim(),
            }),
        });
        const res = await resp.json();
        if (!resp.ok) throw new Error(res.error || "重命名失败");

        const newRel = res.to;
        const newWin = newRel.replace(/\//g, "\\");
        const newFilename = res.new_filename;
        const newStem = newFilename.replace(/\.[^/.]+$/, "");
        const newDisplay = cleanDisplayName(newStem, artist.category);
        const newPreviewUrl = `/api/wfm/models/preview?type=lora&name=${encodeURIComponent(newRel)}&t=${Date.now()}`;
        const newToml = `  # ${artist.category_label}：${newDisplay}${artist.is_notrigger ? " (无触发词)" : ""}\n  [[base.loras]]\n  name         = "${newDisplay}"\n  path         = '${newWin}'\n  model_weight = ${artist.weight_hint}\n  clip_weight  = 1.0`;

        Object.assign(artist, {
            id: newRel,
            filename: newFilename,
            rel_path: newRel,
            win_path: newWin,
            stem: newStem,
            display_name: newDisplay,
            preview_url: newPreviewUrl,
            toml_snippet: newToml,
        });

        cacheTimestamp = Date.now();
        try {
            sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ timestamp: cacheTimestamp, artists: artistsData }));
        } catch {}

        applyFilterAndRender();
        showToast(`✅ 已重命名为: ${newFilename}`, "success");
    } catch (e) {
        showToast(`重命名失败: ${e.message}`, "error");
    }
}

async function moveArtists(targets) {
    if (!targets || targets.length === 0) return;
    try {
        if (!subdirsCache.length) {
            const sResp = await fetch("/api/wfm/models/subdirs?type=lora");
            if (sResp.ok) subdirsCache = await sResp.json();
        }
    } catch {}

    const tip = subdirsCache.length > 0 ? `\n已有目录:\n- ${subdirsCache.join("\n- ")}` : "";
    const dest = prompt(`请输入移动的目标文件夹（留空为根目录，支持多层如 anima/artist/260924）：${tip}`, "");
    if (dest === null) return;

    const destDir = dest.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    try {
        const resp = await fetch("/api/wfm/models/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model_type: "lora",
                model_names: targets.map(t => t.rel_path),
                dest: destDir,
            }),
        });
        const res = await resp.json();
        if (!resp.ok) throw new Error(res.error || "移动失败");

        const movedMap = new Map();
        for (const m of res.moved || []) {
            movedMap.set(m.from, m.to);
        }

        if (movedMap.size > 0) {
            for (const item of artistsData) {
                if (movedMap.has(item.rel_path)) {
                    const newRel = movedMap.get(item.rel_path);
                    const newWin = newRel.replace(/\//g, "\\");
                    const newFilename = newRel.split("/").pop() || newRel;
                    const newStem = newFilename.replace(/\.[^/.]+$/, "");
                    const low = newRel.toLowerCase();
                    const { cat, label } = detectCategoryFromPath(low);
                    const newDisplay = cleanDisplayName(newStem, cat);
                    const newToml = `  # ${label}：${newDisplay}${item.is_notrigger ? " (无触发词)" : ""}\n  [[base.loras]]\n  name         = "${newDisplay}"\n  path         = '${newWin}'\n  model_weight = ${item.weight_hint}\n  clip_weight  = 1.0`;

                    Object.assign(item, {
                        id: newRel,
                        filename: newFilename,
                        rel_path: newRel,
                        win_path: newWin,
                        stem: newStem,
                        category: cat,
                        category_label: label,
                        display_name: newDisplay,
                        preview_url: `/api/wfm/models/preview?type=lora&name=${encodeURIComponent(newRel)}&t=${Date.now()}`,
                        toml_snippet: newToml,
                    });
                }
            }

            cacheTimestamp = Date.now();
            try {
                sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ timestamp: cacheTimestamp, artists: artistsData }));
            } catch {}

            selectedIds.clear();
            applyFilterAndRender();
            showToast(`✅ 成功移动 ${movedMap.size} 个模型`, "success");
        } else if (res.errors && res.errors.length > 0) {
            showToast(`移动失败: ${res.errors[0].error}`, "error");
        }
    } catch (e) {
        showToast(`移动失败: ${e.message}`, "error");
    }
}

async function deleteArtists(targets) {
    if (!targets || targets.length === 0) return;
    const isSingle = targets.length === 1;
    const msg = isSingle
        ? `确认彻底删除模型【${targets[0].display_name}】及其关联预览图和触发词文件？不可撤销！`
        : `确认彻底删除选中的 ${targets.length} 个模型及其关联预览图和触发词文件？不可撤销！`;
    if (!confirm(msg)) return;

    try {
        const resp = await fetch("/api/wfm/models/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model_type: "lora",
                model_names: targets.map(t => t.rel_path),
            }),
        });
        const res = await resp.json();
        if (!resp.ok) throw new Error(res.error || "删除失败");

        const deletedSet = new Set((res.ok || []).map(o => o.model));
        if (deletedSet.size === 0 && isSingle) deletedSet.add(targets[0].rel_path);

        artistsData = artistsData.filter(a => !deletedSet.has(a.rel_path));
        for (const d of deletedSet) selectedIds.delete(d);

        cacheTimestamp = Date.now();
        try {
            sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ timestamp: cacheTimestamp, artists: artistsData }));
        } catch {}

        applyFilterAndRender();
        showToast(`🗑️ 已彻底删除 ${deletedSet.size} 个模型及关联文件`, "success");
    } catch (e) {
        showToast(`删除失败: ${e.message}`, "error");
    }
}

function showArtistDetailModal(artist) {
    const catIcon = artist.category === "artist" ? "🎨" :
                    artist.category === "chara" ? "🎭" :
                    artist.category === "action" ? "🏃" :
                    artist.category === "outfit" ? "👗" :
                    artist.category === "enhancer" ? "✨" :
                    artist.category === "repair" ? "🛠️" : "📦";

    const content = `
        <div style="display: flex; gap: 20px; flex-wrap: wrap; max-height: 80vh; overflow-y: auto;">
            <div style="flex: 1 1 380px; background: #080808; display: flex; align-items: center; justify-content: center; border-radius: 8px; overflow: hidden; min-height: 340px; position: relative; padding: 12px;">
                ${artist.preview_url ? `
                    <img src="${escapeHtml(artist.preview_url)}" aria-hidden="true" style="
                        position: absolute;
                        inset: -20px;
                        width: calc(100% + 40px);
                        height: calc(100% + 40px);
                        object-fit: cover;
                        filter: blur(28px) brightness(0.3) saturate(1.2);
                        pointer-events: none;
                    ">
                    <img src="${escapeHtml(artist.preview_url)}" alt="${escapeHtml(artist.display_name)}" style="
                        position: relative;
                        max-width: 100%;
                        max-height: 520px;
                        object-fit: contain;
                        z-index: 1;
                        border-radius: 6px;
                        box-shadow: 0 8px 30px rgba(0,0,0,0.7);
                    ">
                ` : `
                    <div style="color: #666; text-align: center; padding: 40px;">暂无本地预览大图</div>
                `}
            </div>
            <div style="flex: 1 1 320px; display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <span style="background: var(--wfm-accent, #3b82f6); color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">
                        ${escapeHtml(artist.arch.toUpperCase())}
                    </span>
                    <span style="background: #2563eb; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px;">
                        ${catIcon} ${escapeHtml(artist.category_label || artist.category || "LoRA")}
                    </span>
                    <span style="background: #333; color: #ccc; padding: 2px 8px; border-radius: 4px; font-size: 11px;">
                        ${escapeHtml(artist.group)}
                    </span>
                    ${artist.preview_url ? `
                        <a href="${escapeHtml(artist.preview_url)}" target="_blank" style="color:var(--wfm-accent, #3b82f6); font-size:12px; text-decoration:none; display:inline-flex; align-items:center; gap:4px; margin-left:auto;">
                            🔍 查看原图 ↗
                        </a>
                    ` : ""}
                </div>

                <div>
                    <label style="font-size: 12px; color: #888;">触发词:</label>
                    <div style="margin-top: 4px;">
                        ${artist.is_notrigger ? `
                            <span style="color: #22c55e; font-weight: 500;">✓ 无需触发词 (靠权重生效)</span>
                        ` : artist.triggers && artist.triggers.length > 0 ? `
                            <code style="background:#222; padding:3px 6px; border-radius:4px; color:#60a5fa;">${escapeHtml(artist.triggers.join(", "))}</code>
                        ` : `
                            <span style="color: #888;">未登记独立触发词</span>
                        `}
                    </div>
                </div>

                <div>
                    <label style="font-size: 12px; color: #888;">推荐权重:</label>
                    <span style="color: #eee; font-weight: 600; margin-left: 6px;">${artist.weight_hint || 0.8}</span>
                </div>

                <div>
                    <label style="font-size: 12px; color: #888;">文件路径:</label>
                    <code style="display: block; background: #111; padding: 6px 8px; border-radius: 4px; font-size: 11px; word-break: break-all; margin-top: 4px; color: #aaa;">
                        ${escapeHtml(artist.win_path)}
                    </code>
                </div>

                <div>
                    <label style="font-size: 12px; color: #888;">TOML 配置代码:</label>
                    <pre style="background: #111; padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; margin-top: 4px; color: #38bdf8;">${escapeHtml(artist.toml_snippet)}</pre>
                </div>

                ${artist.info_text ? `
                    <div>
                        <label style="font-size: 12px; color: #888;">说明与建议:</label>
                        <div style="background: #1a1a1a; padding: 8px; border-radius: 4px; font-size: 11px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; margin-top: 4px; color: #aaa;">${escapeHtml(artist.info_text)}</div>
                    </div>
                ` : ""}

                <div style="margin-top: auto; display: flex; gap: 8px; flex-wrap: wrap;">
                    <button class="wfm-btn wfm-btn-primary" id="wfm-modal-copy-toml-btn" style="flex: 1 1 120px;">📋 复制 TOML</button>
                    <button class="wfm-btn" id="wfm-modal-copy-path-btn">复制路径</button>
                    <button class="wfm-btn" id="wfm-modal-rename-btn">✏️ 改名</button>
                    <button class="wfm-btn" id="wfm-modal-move-btn">📁 移动</button>
                    <button class="wfm-btn" id="wfm-modal-delete-btn" style="color: #ef4444;">🗑️ 删除</button>
                </div>
            </div>
        </div>
    `;

    openModal(`${catIcon} ${artist.display_name}`, content);

    document.getElementById("wfm-modal-copy-toml-btn")?.addEventListener("click", () => {
        navigator.clipboard.writeText(artist.toml_snippet);
        showToast("已复制 TOML 配置代码", "success");
    });

    document.getElementById("wfm-modal-copy-path-btn")?.addEventListener("click", () => {
        navigator.clipboard.writeText(artist.win_path);
        showToast("已复制文件路径", "success");
    });

    document.getElementById("wfm-modal-rename-btn")?.addEventListener("click", () => {
        renameArtist(artist);
    });

    document.getElementById("wfm-modal-move-btn")?.addEventListener("click", () => {
        moveArtists([artist]);
    });

    document.getElementById("wfm-modal-delete-btn")?.addEventListener("click", () => {
        deleteArtists([artist]);
    });
}
