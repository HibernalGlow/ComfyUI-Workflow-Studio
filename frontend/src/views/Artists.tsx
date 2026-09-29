import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type ReactElement,
} from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdTextButton,
    MdOutlinedTextField,
    MdIcon,
    MdFilterChip,
    MdChipSet,
    MdSwitch,
    MdCheckbox,
    MdLinearProgress,
} from "../md.js";
import { useSnackbar } from "../snackbar.js";
import { confirmDialog, promptDialog, moveFolderDialog } from "../dialogs.js";
import { api } from "core";
import type { ViewProps } from "../App.js";

export interface ArtistItem {
    id: string;
    filename: string;
    rel_path: string;
    win_path: string;
    stem: string;
    display_name: string;
    category: string;
    category_label: string;
    arch: string;
    group: string;
    has_preview: boolean;
    preview_url: string | null;
    is_notrigger: boolean;
    triggers: string[];
    primary_trigger: string;
    weight_hint: number;
    info_text: string;
    toml_snippet: string;
}

// Category definitions
const CATEGORIES = [
    { id: "all", label: "全部 LoRA", icon: "all_inclusive" },
    { id: "artist", label: "🎨 画师风格", icon: "palette" },
    { id: "chara", label: "🎭 角色", icon: "person" },
    { id: "action", label: "🏃 动作姿态", icon: "accessibility_new" },
    { id: "outfit", label: "👗 服饰换装", icon: "styler" },
    { id: "enhancer", label: "✨ 美学加速", icon: "auto_fix_high" },
    { id: "repair", label: "🛠️ 微调修复", icon: "tune" },
    { id: "other", label: "📦 其他", icon: "category" },
];

function detectCategoryFromPath(low: string): { cat: string; label: string } {
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

function cleanDisplayName(stem: string, _cat?: string): string {
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

const CACHE_STORAGE_KEY = "wfm_artists_cache_v2";
const CACHE_TTL_MS = 3 * 60 * 1000; // 3分钟有效期，期间切换界面 0ms 瞬间打开

// Module-level in-memory cache (survives tab switches)
let memoryArtists: ArtistItem[] | null = null;
let memoryCacheTimestamp = 0;
let lastSearchQuery = "";
let lastCategoryFilter = "all";
let lastArchFilter = "all";

function readPersistentCache(): ArtistItem[] | null {
    if (memoryArtists && memoryArtists.length > 0) return memoryArtists;
    try {
        const raw = sessionStorage.getItem(CACHE_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.artists) && parsed.artists.length > 0) {
                memoryArtists = parsed.artists;
                memoryCacheTimestamp = parsed.timestamp || Date.now();
                return memoryArtists;
            }
        }
    } catch {
        // ignore
    }
    return null;
}

function writePersistentCache(items: ArtistItem[]) {
    memoryArtists = items;
    memoryCacheTimestamp = Date.now();
    try {
        sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({
            timestamp: memoryCacheTimestamp,
            artists: items,
        }));
    } catch {
        // ignore storage quota
    }
}

export default function Artists({ navigate }: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [artists, setArtists] = useState<ArtistItem[]>(() => readPersistentCache() || []);
    const [loading, setLoading] = useState<boolean>(() => !readPersistentCache() || (readPersistentCache()?.length ?? 0) === 0);
    const [search, setSearchState] = useState<string>(() => lastSearchQuery);
    const [categoryFilter, setCategoryFilterState] = useState<string>(() => lastCategoryFilter);
    const [archFilter, setArchFilterState] = useState<string>(() => lastArchFilter);
    const [onlyWithPreview, setOnlyWithPreview] = useState<boolean>(false); // Default false to show ALL LoRAs
    const [lightboxItem, setLightboxItem] = useState<ArtistItem | null>(null);
    const [applyingPath, setApplyingPath] = useState<string | null>(null);
    const [manageMode, setManageMode] = useState<boolean>(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [subdirs, setSubdirs] = useState<string[]>([]);

    const setSearch = (val: string) => {
        lastSearchQuery = val;
        setSearchState(val);
    };
    const setCategoryFilter = (val: string) => {
        lastCategoryFilter = val;
        setCategoryFilterState(val);
    };
    const setArchFilter = (val: string) => {
        lastArchFilter = val;
        setArchFilterState(val);
    };
    const [fitMode, setFitMode] = useState<"contain" | "cover">(() => {
        try {
            return (localStorage.getItem("wfm_artists_fit_mode") as "contain" | "cover") || "contain";
        } catch {
            return "contain";
        }
    });

    const toggleFitMode = () => {
        const next = fitMode === "contain" ? "cover" : "contain";
        setFitMode(next);
        try {
            localStorage.setItem("wfm_artists_fit_mode", next);
        } catch {
            // ignore
        }
    };

    // Fetch artists data with caching & incremental background revalidation (SWR)
    const loadArtists = useCallback(async (forceRefresh = false) => {
        const hasCache = Boolean(memoryArtists && memoryArtists.length > 0);
        const isFresh = Date.now() - memoryCacheTimestamp < CACHE_TTL_MS;

        // If not forcing refresh and cache is fresh, 0ms instant display without network
        if (hasCache && isFresh && !forceRefresh) {
            setLoading(false);
            return;
        }

        // Only show spinner if there is no cache at all or user explicitly asked for full refresh
        if (!hasCache || forceRefresh) {
            setLoading(true);
        }

        try {
            const data = (await api.listArtists({ refresh: forceRefresh })) as {
                artists?: ArtistItem[];
            };
            if (data?.artists && Array.isArray(data.artists) && data.artists.length > 50) {
                writePersistentCache(data.artists);
                setArtists(data.artists);
                setLoading(false);
                if (forceRefresh) {
                    snackbar.show({ label: `全库扫描完成，已加载 ${data.artists.length} 个 LoRA`, tone: "neutral" });
                }
                return;
            }
        } catch {
            // Fall through to raw files
        }

        // Fallback: Fetch all LoRAs from ComfyUI
        try {
            const rawFiles = (await api.listModelFiles("lora")) as string[];
            if (Array.isArray(rawFiles)) {
                // Incremental check: if files count and paths match existing cache, don't re-render!
                if (hasCache && !forceRefresh && memoryArtists) {
                    const currentPaths = new Set(memoryArtists.map((a) => a.rel_path));
                    const isSame = rawFiles.length === memoryArtists.length && rawFiles.every((f) => currentPaths.has(f.replace(/\\/g, "/")));
                    if (isSame) {
                        memoryCacheTimestamp = Date.now();
                        setLoading(false);
                        return;
                    }
                }

                const list: ArtistItem[] = [];

                for (const raw of rawFiles) {
                    const rel_path = raw.replace(/\\/g, "/");
                    const win_path = raw.replace(/\//g, "\\");
                    const low = rel_path.toLowerCase();
                    const filename = rel_path.split("/").pop() || rel_path;
                    const stem = filename.replace(/\.[^/.]+$/, "");

                    const { cat, label } = detectCategoryFromPath(low);
                    const display_name = cleanDisplayName(stem, cat);
                    const arch = low.includes("anima") ? "anima" : low.includes("illus") ? "illustrious" : low.includes("2real") || low.includes("flux") ? "flux" : "other";

                    // Determine sub-group
                    let group = "通用";
                    if (low.includes("260924")) group = "260924 精选";
                    else if (low.includes("self")) group = "自训 (Self)";
                    else if (low.includes("2606") || low.includes("2607")) group = "2606/2607 库";
                    else if (low.includes("azurlane")) group = "碧蓝航线";
                    else if (low.includes("endfield")) group = "终末地";
                    else if (low.includes("snowbreak")) group = "尘白禁区";
                    else if (low.includes("lycoris")) group = "LyCORIS";
                    else if (low.includes("2real")) group = "2REAL";

                    // Known preview detection
                    const has_preview = low.includes("260924") || low.includes(".preview") || low.includes("atdan") || low.includes("freng") || low.includes("bubble") || low.includes("laffey") || low.includes("niannian") || low.includes("typhoeus") || low.includes("ankasha");
                    const preview_url = `/api/wfm/models/preview?type=lora&name=${encodeURIComponent(rel_path)}`;

                    const is_notrigger = low.includes("notrigger") || stem.includes("Oyari") || stem.includes("Pija") || stem.includes("sayappa");
                    const triggers: string[] = [];
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
                        primary_trigger: triggers[0] || "",
                        weight_hint,
                        info_text: "",
                        toml_snippet,
                    });
                }

                // Sort: items with preview first, then category, then name
                list.sort((a, b) => {
                    if (a.has_preview !== b.has_preview) return a.has_preview ? -1 : 1;
                    if (a.group.includes("260924") !== b.group.includes("260924")) {
                        return a.group.includes("260924") ? -1 : 1;
                    }
                    return a.display_name.localeCompare(b.display_name);
                });

                writePersistentCache(list);
                setArtists(list);
                if (forceRefresh) {
                    snackbar.show({ label: `全库扫描完成，已加载 ${list.length} 个 LoRA`, tone: "neutral" });
                }
            }
        } catch (e) {
            console.error("Failed to load loras", e);
            if (!hasCache) {
                snackbar.show({ label: "加载 LoRA 列表失败，请检查连接", tone: "error" });
            }
        } finally {
            setLoading(false);
        }
    }, [snackbar]);

    useEffect(() => {
        void loadArtists(false);
        void api.getSubdirs("lora").then((res) => {
            if (Array.isArray(res)) setSubdirs(res);
        }).catch(() => {});
    }, [loadArtists]);

    // Rename single model
    const handleRename = useCallback(
        async (artist: ArtistItem) => {
            const promptRes = await promptDialog({
                title: "重命名模型",
                body: `重命名将同步更改关联的预览图 (.preview.png/.jpg) 以及触发词文件 (.trigger.txt/.txt)。当前文件名: ${artist.filename}`,
                value: artist.filename,
                confirmLabel: "保存重命名",
            });
            if (!promptRes || promptRes.trim() === "" || promptRes.trim() === artist.filename) return;

            const newName = promptRes.trim();
            try {
                const apiAny = api as unknown as {
                    renameModel: (t: string, o: string, n: string) => Promise<{ status: string; from: string; to: string; new_filename: string }>;
                };
                const res = await apiAny.renameModel("lora", artist.rel_path, newName);
                const newRel = res.to;
                const newWin = newRel.replace(/\//g, "\\");
                const newFilename = res.new_filename;
                const newStem = newFilename.replace(/\.[^/.]+$/, "");
                const newDisplay = cleanDisplayName(newStem, artist.category);
                const newPreviewUrl = `/api/wfm/models/preview?type=lora&name=${encodeURIComponent(newRel)}&t=${Date.now()}`;
                const newToml = `  # ${artist.category_label}：${newDisplay}${artist.is_notrigger ? " (无触发词)" : ""}\n  [[base.loras]]\n  name         = "${newDisplay}"\n  path         = '${newWin}'\n  model_weight = ${artist.weight_hint}\n  clip_weight  = 1.0`;

                const updatedItem: ArtistItem = {
                    ...artist,
                    id: newRel,
                    filename: newFilename,
                    rel_path: newRel,
                    win_path: newWin,
                    stem: newStem,
                    display_name: newDisplay,
                    preview_url: newPreviewUrl,
                    toml_snippet: newToml,
                };

                setArtists((prev) => {
                    const next = prev.map((item) => (item.rel_path === artist.rel_path ? updatedItem : item));
                    writePersistentCache(next);
                    return next;
                });

                if (lightboxItem?.rel_path === artist.rel_path) {
                    setLightboxItem(updatedItem);
                }

                snackbar.show({ label: `✅ 已重命名为: ${newFilename}`, tone: "neutral" });
            } catch (err) {
                snackbar.show({ label: `重命名失败: ${(err as Error).message}`, tone: "error" });
            }
        },
        [lightboxItem, snackbar],
    );

    // Move single or batch models
    const handleMove = useCallback(
        async (targets: ArtistItem[]) => {
            if (targets.length === 0) return;
            const dest = await moveFolderDialog({
                title: `移动 ${targets.length} 个模型到目标文件夹`,
                subdirs,
                confirmLabel: "确认移动",
            });
            if (dest === null) return;

            try {
                const targetPaths = targets.map((t) => t.rel_path);
                const res = (await api.moveModels("lora", targetPaths, dest)) as {
                    moved?: Array<{ from: string; to: string }>;
                    errors?: Array<{ model: string; error: string }>;
                };

                const movedMap = new Map<string, string>();
                if (res?.moved) {
                    for (const m of res.moved) {
                        movedMap.set(m.from, m.to);
                    }
                }

                if (movedMap.size > 0) {
                    setArtists((prev) => {
                        const next = prev.map((item) => {
                            if (movedMap.has(item.rel_path)) {
                                const newRel = movedMap.get(item.rel_path)!;
                                const newWin = newRel.replace(/\//g, "\\");
                                const newFilename = newRel.split("/").pop() || newRel;
                                const newStem = newFilename.replace(/\.[^/.]+$/, "");
                                const low = newRel.toLowerCase();
                                const { cat, label } = detectCategoryFromPath(low);
                                const newDisplay = cleanDisplayName(newStem, cat);
                                const newToml = `  # ${label}：${newDisplay}${item.is_notrigger ? " (无触发词)" : ""}\n  [[base.loras]]\n  name         = "${newDisplay}"\n  path         = '${newWin}'\n  model_weight = ${item.weight_hint}\n  clip_weight  = 1.0`;

                                return {
                                    ...item,
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
                                };
                            }
                            return item;
                        });
                        writePersistentCache(next);
                        return next;
                    });

                    // Update subdirs if dest was a new dir
                    if (dest && !subdirs.includes(dest)) {
                        setSubdirs((prev) => [...prev, dest].sort());
                    }

                    setSelectedIds(new Set());
                    snackbar.show({
                        label: `✅ 成功移动 ${movedMap.size} 个模型到 ${dest || "根目录"}${res?.errors?.length ? ` (${res.errors.length} 个错误)` : ""}`,
                        tone: "neutral",
                    });
                } else if (res?.errors?.length) {
                    snackbar.show({ label: `移动失败: ${res.errors[0]?.error}`, tone: "error" });
                }
            } catch (err) {
                snackbar.show({ label: `移动失败: ${(err as Error).message}`, tone: "error" });
            }
        },
        [subdirs, snackbar],
    );

    // Delete single or batch models
    const handleDelete = useCallback(
        async (targets: ArtistItem[]) => {
            if (targets.length === 0) return;
            const isSingle = targets.length === 1;
            const confirmed = await confirmDialog({
                title: isSingle ? `确认删除模型【${targets[0]!.display_name}】？` : `确认删除选中的 ${targets.length} 个模型？`,
                body: "此操作将彻底删除模型文件及其附属的预览图 (.preview.png/.jpg) 和触发词文件 (.trigger.txt/.txt)，不可撤销！",
                danger: true,
                confirmLabel: "确认彻底删除",
            });
            if (!confirmed) return;

            try {
                const targetPaths = targets.map((t) => t.rel_path);
                const res = (await api.deleteModels("lora", targetPaths)) as {
                    status?: string;
                    ok?: Array<{ model: string }>;
                    errors?: Array<{ model: string; error: string }>;
                };

                const deletedSet = new Set((res?.ok || []).map((o) => o.model));
                if (deletedSet.size === 0 && isSingle) {
                    deletedSet.add(targets[0]!.rel_path);
                }

                setArtists((prev) => {
                    const next = prev.filter((item) => !deletedSet.has(item.rel_path));
                    writePersistentCache(next);
                    return next;
                });

                if (lightboxItem && deletedSet.has(lightboxItem.rel_path)) {
                    setLightboxItem(null);
                }

                setSelectedIds((prev) => {
                    const next = new Set(prev);
                    for (const id of deletedSet) next.delete(id);
                    return next;
                });

                snackbar.show({
                    label: `🗑️ 已删除 ${deletedSet.size} 个模型及其关联文件`,
                    tone: "neutral",
                });
            } catch (err) {
                snackbar.show({ label: `删除失败: ${(err as Error).message}`, tone: "error" });
            }
        },
        [lightboxItem, snackbar],
    );

    const toggleSelect = useCallback((relPath: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(relPath)) next.delete(relPath);
            else next.add(relPath);
            return next;
        });
    }, []);

    // Filtered list
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return artists.filter((a) => {
            if (onlyWithPreview && !a.has_preview) return false;
            if (categoryFilter !== "all" && a.category !== categoryFilter) return false;
            if (archFilter !== "all" && a.arch.toLowerCase() !== archFilter) return false;
            if (q) {
                const matchName = a.display_name.toLowerCase().includes(q);
                const matchStem = a.stem.toLowerCase().includes(q);
                const matchPath = a.rel_path.toLowerCase().includes(q);
                const matchTrig = a.triggers.some((t) => t.toLowerCase().includes(q));
                const matchGroup = a.group.toLowerCase().includes(q);
                if (!matchName && !matchStem && !matchPath && !matchTrig && !matchGroup) return false;
            }
            return true;
        });
    }, [artists, search, categoryFilter, archFilter, onlyWithPreview]);

    // Copy helper
    const copyToClipboard = useCallback(
        (text: string, label: string) => {
            void navigator.clipboard.writeText(text);
            snackbar.show({ label: `已复制 ${label}`, tone: "neutral" });
        },
        [snackbar],
    );

    // Apply to current batch.toml
    const applyToBatch = useCallback(
        async (artist: ArtistItem) => {
            setApplyingPath(artist.rel_path);
            try {
                await api.applyArtistToBatch({
                    toml_path: "碧蓝航线_拉菲II",
                    artist_path: artist.win_path,
                    name: artist.display_name,
                    model_weight: artist.weight_hint,
                    clip_weight: 1.0,
                });
                snackbar.show({
                    label: `✅ 已成功将【${artist.display_name}】写入拉菲II batch.toml`,
                    tone: "neutral",
                    duration: "long",
                });
            } catch (err) {
                snackbar.show({
                    label: `应用失败: ${(err as Error).message || "请手动复制 TOML 配置"}`,
                    tone: "error",
                });
                snackbar.show({
                    label: `已为您复制 TOML 片段`,
                    tone: "neutral",
                });
                void navigator.clipboard.writeText(artist.toml_snippet);
            } finally {
                setApplyingPath(null);
            }
        },
        [snackbar],
    );

    const withPreviewCount = useMemo(() => artists.filter((a) => a.has_preview).length, [artists]);

    return (
        <div className="nu-view" style={{ padding: "16px 24px", height: "100%", overflowY: "auto" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                    <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
                        <span>🎨 全量 LoRA 视觉画廊与挑选中心</span>
                        <span style={{ fontSize: 13, fontWeight: "normal", color: "var(--md-sys-color-outline)", backgroundColor: "var(--md-sys-color-surface-container)", padding: "2px 10px", borderRadius: 12 }}>
                            全库 {artists.length} 个 LoRA · {withPreviewCount} 个带预览图 · 当前显示 {filtered.length} 个
                        </span>
                    </h2>
                    <p style={{ margin: 0, fontSize: 13, color: "var(--md-sys-color-outline)" }}>
                        涵盖全库画师、角色、动作、服装及美学 LoRA。可直观查看画风与效果预览，一键复制路径、复制 TOML 或直接应用。
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <MdOutlinedButton
                        onClick={() => {
                            setManageMode((prev) => !prev);
                            setSelectedIds(new Set());
                        }}
                        style={{
                            backgroundColor: manageMode ? "var(--md-sys-color-secondary-container)" : undefined,
                        }}
                    >
                        <MdIcon slot="icon">{manageMode ? "check_box" : "check_box_outline_blank"}</MdIcon>
                        {manageMode ? "退出管理" : "批量管理"}
                    </MdOutlinedButton>
                    <MdOutlinedButton onClick={() => void loadArtists(true)}>
                        <MdIcon slot="icon">refresh</MdIcon>
                        重新扫描全库
                    </MdOutlinedButton>
                    <MdFilledButton onClick={() => navigate("models")}>
                        <MdIcon slot="icon">inventory_2</MdIcon>
                        模型管理
                    </MdFilledButton>
                </div>
            </div>

            {loading ? <MdLinearProgress indeterminate style={{ marginBottom: 16 }} /> : null}

            {/* Filter toolbar */}
            <div
                style={{
                    backgroundColor: "var(--md-sys-color-surface-container-low)",
                    padding: "14px 18px",
                    borderRadius: 14,
                    marginBottom: 20,
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                }}
            >
                {/* Category tabs */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, color: "var(--md-sys-color-outline)", fontWeight: 600 }}>分类:</span>
                    <MdChipSet>
                        {CATEGORIES.map((cat) => {
                            const count = cat.id === "all" ? artists.length : artists.filter((a) => a.category === cat.id).length;
                            return (
                                <MdFilterChip
                                    key={cat.id}
                                    label={`${cat.label} (${count})`}
                                    selected={categoryFilter === cat.id}
                                    onClick={() => setCategoryFilter(cat.id)}
                                />
                            );
                        })}
                    </MdChipSet>
                </div>

                {/* Search & preview switch */}
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 320px" }}>
                        <MdOutlinedTextField
                            label="搜索任意 LoRA 名称 / 角色 / 画师 / 触发词 / 路径..."
                            value={search}
                            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                            style={{ width: "100%" }}
                        >
                            <MdIcon slot="leading-icon">search</MdIcon>
                            {search ? (
                                <MdTextButton slot="trailing-icon" onClick={() => setSearch("")}>
                                    ✕
                                </MdTextButton>
                            ) : null}
                        </MdOutlinedTextField>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, color: "var(--md-sys-color-outline)", fontWeight: 500 }}>架构:</span>
                        <MdChipSet>
                            {["all", "anima", "illustrious", "flux"].map((arch) => (
                                <MdFilterChip
                                    key={arch}
                                    label={arch === "all" ? "全部架构" : arch.toUpperCase()}
                                    selected={archFilter === arch}
                                    onClick={() => setArchFilter(arch)}
                                />
                            ))}
                        </MdChipSet>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto", flexWrap: "wrap" }}>
                        <MdFilterChip
                            label={fitMode === "contain" ? "🖼️ 完整自适应 (无裁切)" : "📐 裁切铺满"}
                            selected={fitMode === "contain"}
                            onClick={toggleFitMode}
                            title="切换图片显示模式：自适应完整展示（包含氛围光晕）或铺满裁切"
                        />
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                            <MdSwitch
                                selected={onlyWithPreview}
                                onChange={(e) => setOnlyWithPreview(Boolean((e.target as unknown as { selected?: boolean }).selected))}
                            />
                            <span>仅看带图 ({withPreviewCount})</span>
                        </label>
                    </div>
                </div>

                {/* Batch management toolbar */}
                {manageMode ? (
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            backgroundColor: "var(--md-sys-color-surface-container-high)",
                            padding: "8px 14px",
                            borderRadius: 10,
                            marginTop: 4,
                            flexWrap: "wrap",
                        }}
                    >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                            已选中 {selectedIds.size} / {filtered.length} 项
                        </span>
                        <MdTextButton
                            onClick={() => {
                                if (selectedIds.size === filtered.length) {
                                    setSelectedIds(new Set());
                                } else {
                                    setSelectedIds(new Set(filtered.map((a) => a.rel_path)));
                                }
                            }}
                        >
                            {selectedIds.size === filtered.length ? "取消全选" : "全选当前筛选结果"}
                        </MdTextButton>

                        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                            <MdOutlinedButton
                                disabled={selectedIds.size === 0}
                                onClick={() => {
                                    const targets = artists.filter((a) => selectedIds.has(a.rel_path));
                                    void handleMove(targets);
                                }}
                            >
                                <MdIcon slot="icon">drive_file_move</MdIcon>
                                批量移动 ({selectedIds.size})
                            </MdOutlinedButton>
                            <MdFilledButton
                                className="nu-btn--danger"
                                disabled={selectedIds.size === 0}
                                onClick={() => {
                                    const targets = artists.filter((a) => selectedIds.has(a.rel_path));
                                    void handleDelete(targets);
                                }}
                            >
                                <MdIcon slot="icon">delete_forever</MdIcon>
                                批量删除 ({selectedIds.size})
                            </MdFilledButton>
                        </div>
                    </div>
                ) : null}
            </div>

            {/* Grid display */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                    gap: 18,
                    paddingBottom: 40,
                }}
            >
                {filtered.map((artist) => (
                    <ArtistCard
                        key={artist.id}
                        artist={artist}
                        fitMode={fitMode}
                        manageMode={manageMode}
                        isSelected={selectedIds.has(artist.rel_path)}
                        onToggleSelect={() => toggleSelect(artist.rel_path)}
                        onPreviewClick={() => setLightboxItem(artist)}
                        onCopyPath={() => copyToClipboard(artist.win_path, "Windows 路径")}
                        onCopyToml={() => copyToClipboard(artist.toml_snippet, "TOML 配置代码")}
                        onCopyTrigger={(t) => copyToClipboard(t, "触发词")}
                        onApply={() => void applyToBatch(artist)}
                        onRename={() => void handleRename(artist)}
                        onMove={() => void handleMove([artist])}
                        onDelete={() => void handleDelete([artist])}
                        isApplying={applyingPath === artist.rel_path}
                    />
                ))}
            </div>

            {filtered.length === 0 && !loading ? (
                <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--md-sys-color-outline)" }}>
                    <MdIcon style={{ fontSize: 48, marginBottom: 12 }}>image_not_supported</MdIcon>
                    <p style={{ fontSize: 16 }}>没有找到符合条件的 LoRA</p>
                    <MdTextButton onClick={() => { setSearch(""); setCategoryFilter("all"); setOnlyWithPreview(false); setArchFilter("all"); }}>
                        重置所有筛选 (显示全量 305 个 LoRA)
                    </MdTextButton>
                </div>
            ) : null}

            {/* Lightbox / Detail Dialog */}
            {lightboxItem ? (
                <div
                    className="nu-artist-lightbox-scrim"
                    onClick={() => setLightboxItem(null)}
                >
                    <div
                        className="nu-artist-lightbox-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Image preview column */}
                        <div
                            className="nu-artist-lightbox-preview"
                        >
                            {lightboxItem.preview_url ? (
                                <>
                                    <img
                                        src={lightboxItem.preview_url}
                                        alt=""
                                        aria-hidden="true"
                                        style={{
                                            position: "absolute",
                                            inset: "-20px",
                                            width: "calc(100% + 40px)",
                                            height: "calc(100% + 40px)",
                                            objectFit: "cover",
                                            filter: "blur(30px) brightness(0.3) saturate(1.2)",
                                            pointerEvents: "none",
                                            userSelect: "none",
                                        }}
                                    />
                                    <img
                                        src={lightboxItem.preview_url}
                                        alt={lightboxItem.display_name}
                                        className="nu-artist-lightbox-img"
                                    />
                                </>
                            ) : (
                                <div className="nu-artist-lightbox-empty">
                                    <MdIcon style={{ fontSize: 64 }}>image</MdIcon>
                                    <p>无本地预览大图</p>
                                </div>
                            )}
                        </div>

                        {/* Details column */}
                        <div
                            style={{
                                flex: "1 1 44%",
                                padding: 24,
                                display: "flex",
                                flexDirection: "column",
                                overflowY: "auto",
                                maxHeight: "88vh",
                            }}
                        >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                                <div>
                                    <h3 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 600 }}>{lightboxItem.display_name}</h3>
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                        <span className="nu-artist-cat-badge">
                                            {lightboxItem.category_label}
                                        </span>
                                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, backgroundColor: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)" }}>
                                            {lightboxItem.arch.toUpperCase()}
                                        </span>
                                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, backgroundColor: "var(--md-sys-color-surface-container-high)", color: "var(--md-sys-color-outline)" }}>
                                            {lightboxItem.group}
                                        </span>
                                        {lightboxItem.preview_url ? (
                                            <a
                                                href={lightboxItem.preview_url}
                                                target="_blank"
                                                rel="noreferrer"
                                                style={{
                                                    fontSize: 12,
                                                    color: "var(--md-sys-color-primary)",
                                                    textDecoration: "none",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: 4,
                                                    marginLeft: 4,
                                                }}
                                                title="在新标签页全屏查看原始画质与尺寸"
                                            >
                                                🔍 查看原图 ↗
                                            </a>
                                        ) : null}
                                    </div>
                                </div>
                                <MdTextButton onClick={() => setLightboxItem(null)}>✕</MdTextButton>
                            </div>

                            <div style={{ margin: "16px 0", fontSize: 13 }}>
                                <div style={{ color: "var(--md-sys-color-outline)", marginBottom: 4, fontWeight: 500 }}>触发词 (Triggers):</div>
                                {lightboxItem.is_notrigger ? (
                                    <span className="nu-artist-notrigger-badge">
                                        ✓ 无需触发词 (No Trigger Word) · 靠权重即生效
                                    </span>
                                ) : lightboxItem.triggers.length > 0 ? (
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                        {lightboxItem.triggers.map((t) => (
                                            <span
                                                key={t}
                                                style={{ backgroundColor: "var(--md-sys-color-secondary-container)", color: "var(--md-sys-color-on-secondary-container)", padding: "3px 8px", borderRadius: 4, cursor: "pointer" }}
                                                onClick={() => copyToClipboard(t, "触发词")}
                                                title="点击复制"
                                            >
                                                {t} 📋
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <span style={{ color: "var(--md-sys-color-outline)" }}>未登记独立触发词</span>
                                )}
                            </div>

                            <div style={{ margin: "12px 0", fontSize: 13 }}>
                                <div style={{ color: "var(--md-sys-color-outline)", marginBottom: 4, fontWeight: 500 }}>LoRA 磁盘路径:</div>
                                <code style={{ display: "block", backgroundColor: "var(--md-sys-color-surface-container-highest)", padding: "8px 10px", borderRadius: 6, fontSize: 12, wordBreak: "break-all" }}>
                                    {lightboxItem.win_path}
                                </code>
                            </div>

                            <div style={{ margin: "12px 0", fontSize: 13 }}>
                                <div style={{ color: "var(--md-sys-color-outline)", marginBottom: 4, fontWeight: 500 }}>TOML 配置片段:</div>
                                <pre style={{ margin: 0, backgroundColor: "var(--md-sys-color-surface-container-highest)", padding: "10px", borderRadius: 6, fontSize: 12, overflowX: "auto" }}>
                                    {lightboxItem.toml_snippet}
                                </pre>
                            </div>

                            {lightboxItem.info_text ? (
                                <div style={{ margin: "12px 0", fontSize: 12, color: "var(--md-sys-color-outline)" }}>
                                    <div style={{ marginBottom: 4, fontWeight: 500 }}>说明与建议:</div>
                                    <div style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto", backgroundColor: "var(--md-sys-color-surface-container)", padding: 8, borderRadius: 6 }}>
                                        {lightboxItem.info_text}
                                    </div>
                                </div>
                            ) : null}

                            <div style={{ marginTop: "auto", paddingTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <MdFilledButton style={{ flex: "1 1 120px" }} onClick={() => copyToClipboard(lightboxItem.toml_snippet, "TOML 配置")}>
                                    <MdIcon slot="icon">content_copy</MdIcon>
                                    复制 TOML
                                </MdFilledButton>
                                <MdOutlinedButton onClick={() => copyToClipboard(lightboxItem.win_path, "路径")}>
                                    路径
                                </MdOutlinedButton>
                                <MdOutlinedButton onClick={() => void handleRename(lightboxItem)}>
                                    ✏️ 改名
                                </MdOutlinedButton>
                                <MdOutlinedButton onClick={() => void handleMove([lightboxItem])}>
                                    📁 移动
                                </MdOutlinedButton>
                                <MdOutlinedButton
                                    style={{ color: "var(--md-sys-color-error)" }}
                                    onClick={() => void handleDelete([lightboxItem])}
                                >
                                    🗑️ 删除
                                </MdOutlinedButton>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function ArtistCard({
    artist,
    fitMode,
    manageMode,
    isSelected,
    onToggleSelect,
    onPreviewClick,
    onCopyPath,
    onCopyToml,
    onCopyTrigger,
    onApply,
    onRename,
    onMove,
    onDelete,
    isApplying,
}: {
    artist: ArtistItem;
    fitMode: "contain" | "cover";
    manageMode: boolean;
    isSelected: boolean;
    onToggleSelect: () => void;
    onPreviewClick: () => void;
    onCopyPath: () => void;
    onCopyToml: () => void;
    onCopyTrigger: (t: string) => void;
    onApply: () => void;
    onRename: () => void;
    onMove: () => void;
    onDelete: () => void;
    isApplying: boolean;
}): ReactElement {
    const [imgFailed, setImgFailed] = useState(false);

    return (
        <div
            style={{
                backgroundColor: "var(--md-sys-color-surface-container)",
                borderRadius: 14,
                overflow: "hidden",
                border: isSelected
                    ? "2px solid var(--md-sys-color-primary)"
                    : "1px solid var(--md-sys-color-outline-variant)",
                display: "flex",
                flexDirection: "column",
                transition: "transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease",
                position: "relative",
            }}
            className="artist-card-hover"
        >
            {/* Thumbnail area: 250px vertical height */}
            <div
                className="nu-artist-card-thumb"
                style={{
                    cursor: manageMode ? "pointer" : artist.has_preview && !imgFailed ? "zoom-in" : "default",
                }}
                onClick={() => {
                    if (manageMode) {
                        onToggleSelect();
                    } else if (artist.has_preview && !imgFailed) {
                        onPreviewClick();
                    }
                }}
            >
                {/* Checkbox for batch management */}
                {manageMode ? (
                    <div
                        style={{
                            position: "absolute",
                            top: 8,
                            left: 8,
                            zIndex: 10,
                            backgroundColor: "rgba(0,0,0,0.6)",
                            borderRadius: 8,
                            padding: "2px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleSelect();
                        }}
                    >
                        <MdCheckbox checked={isSelected} />
                    </div>
                ) : null}

                {artist.preview_url && !imgFailed ? (
                    <>
                        {fitMode === "contain" ? (
                            <img
                                src={artist.preview_url}
                                alt=""
                                aria-hidden="true"
                                style={{
                                    position: "absolute",
                                    inset: "-15%",
                                    width: "130%",
                                    height: "130%",
                                    objectFit: "cover",
                                    filter: "blur(20px) brightness(0.35) saturate(1.2)",
                                    pointerEvents: "none",
                                    userSelect: "none",
                                }}
                            />
                        ) : null}
                        <img
                            src={artist.preview_url}
                            alt={artist.display_name}
                            loading="lazy"
                            onError={() => setImgFailed(true)}
                            style={{
                                position: fitMode === "contain" ? "relative" : "absolute",
                                top: fitMode === "contain" ? undefined : 0,
                                left: fitMode === "contain" ? undefined : 0,
                                width: "100%",
                                height: "100%",
                                objectFit: fitMode,
                                zIndex: 1,
                                transition: "transform 0.25s ease",
                            }}
                        />
                    </>
                ) : (
                    <div
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--md-sys-color-outline)",
                            gap: 6,
                        }}
                    >
                        <MdIcon style={{ fontSize: 36 }}>
                            {artist.category === "chara" ? "person" : artist.category === "action" ? "accessibility_new" : artist.category === "outfit" ? "styler" : "brush"}
                        </MdIcon>
                        <span style={{ fontSize: 12 }}>无预览图</span>
                    </div>
                )}

                {/* Badges on top of image (offset right if checkbox is visible) */}
                <div style={{ position: "absolute", top: 8, left: manageMode ? 52 : 8, display: "flex", gap: 5, flexWrap: "wrap", zIndex: 5 }}>
                    <span className="nu-artist-chip-category">
                        {artist.category_label}
                    </span>
                    <span className="nu-artist-chip-arch">
                        {artist.arch}
                    </span>
                    <span className="nu-artist-chip-group">
                        {artist.group}
                    </span>
                </div>
            </div>

            {/* Info body */}
            <div style={{ padding: "12px 14px", flex: 1, display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                    <h4
                        style={{
                            margin: 0,
                            fontSize: 15,
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                        }}
                        title={artist.display_name}
                    >
                        {artist.display_name}
                    </h4>
                </div>

                {/* Trigger pill */}
                <div style={{ marginBottom: 10, minHeight: 24, display: "flex", alignItems: "center" }}>
                    {artist.is_notrigger ? (
                        <span className="nu-artist-notrigger-pill">
                            ✓ 无需触发词 (notrigger)
                        </span>
                    ) : artist.triggers.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {artist.triggers.slice(0, 2).map((t) => (
                                <span
                                    key={t}
                                    style={{ fontSize: 11, color: "var(--md-sys-color-primary)", backgroundColor: "var(--md-sys-color-primary-container)", padding: "2px 6px", borderRadius: 4, cursor: "pointer" }}
                                    onClick={() => onCopyTrigger(t)}
                                    title="点击复制此触发词"
                                >
                                    {t}
                                </span>
                            ))}
                            {artist.triggers.length > 2 ? <span style={{ fontSize: 11, color: "var(--md-sys-color-outline)" }}>+{artist.triggers.length - 2}</span> : null}
                        </div>
                    ) : (
                        <span style={{ fontSize: 11, color: "var(--md-sys-color-outline)" }}>默认无需额外词</span>
                    )}
                </div>

                {/* Subtitle / path */}
                <div
                    style={{
                        fontSize: 11,
                        color: "var(--md-sys-color-outline)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginBottom: 10,
                    }}
                    title={artist.win_path}
                >
                    {artist.filename}
                </div>

                {/* Row 1: Copy TOML, Path, Apply */}
                <div style={{ marginTop: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <MdFilledButton
                        style={{ flex: "1 1 90px", height: 32, fontSize: 12 }}
                        onClick={onCopyToml}
                        title="复制可直接贴入 batch.toml 的配置块"
                    >
                        <MdIcon slot="icon" style={{ fontSize: 16 }}>content_copy</MdIcon>
                        复制 TOML
                    </MdFilledButton>

                    <MdOutlinedButton
                        style={{ height: 32, fontSize: 12 }}
                        onClick={onCopyPath}
                        title="复制 Windows 端完整路径"
                    >
                        路径
                    </MdOutlinedButton>

                    <MdTextButton
                        style={{ height: 32, fontSize: 11 }}
                        onClick={onApply}
                        disabled={isApplying}
                        title="一键写入当前作品 batch.toml"
                    >
                        {isApplying ? "应用中..." : "应用"}
                    </MdTextButton>
                </div>

                {/* Row 2: Management buttons (Rename, Move, Delete) */}
                <div
                    style={{
                        display: "flex",
                        gap: 4,
                        marginTop: 8,
                        paddingTop: 6,
                        borderTop: "1px dashed var(--md-sys-color-outline-variant)",
                    }}
                >
                    <MdTextButton
                        style={{ flex: 1, height: 28, fontSize: 11 }}
                        onClick={onRename}
                        title="重命名模型文件及关联预览图和触发词文件"
                    >
                        ✏️ 改名
                    </MdTextButton>
                    <MdTextButton
                        style={{ flex: 1, height: 28, fontSize: 11 }}
                        onClick={onMove}
                        title="移动模型及关联文件到指定子目录"
                    >
                        📁 移动
                    </MdTextButton>
                    <MdTextButton
                        style={{ flex: 1, height: 28, fontSize: 11, color: "var(--md-sys-color-error)" }}
                        onClick={onDelete}
                        title="彻底删除模型及关联文件"
                    >
                        🗑️ 删除
                    </MdTextButton>
                </div>
            </div>
        </div>
    );
}
