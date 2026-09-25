import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
    type ReactElement,
} from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdTextButton,
    MdOutlinedTextField,
    MdOutlinedCard,
    MdLinearProgress,
    MdIcon,
    MdDivider,
    MdTabs,
    MdPrimaryTab,
    MdCheckbox,
    MdSwitch,
    MdFilterChip,
    MdChipSet,
} from "../md.js";
import { useSnackbar } from "../snackbar.js";
import { requestApply, requestPromptAppend, getState, touchBatch } from "../store.js";
import { batch as B } from "core";
import { confirmDialog, promptDialog } from "../dialogs.js";
import {
    api,
    models as M,
    modelConstants as MC,
    readPref,
    writePref,
    escapeHtml,
    tr,
} from "core";
import type { ViewProps } from "../App.js";

type SortKey = (typeof MC.SORT_COLUMNS)[number];
type ViewMode = "thumb" | "table";

interface Record_ {
    name: string;
    base: string;
    subdir: string;
    ext: string;
    tags: string[];
    memo: string;
    badges: string[];
    favorite: boolean;
    sha256: string;
    enabled: boolean;
    groups: string[];
    civType: string;
    baseModel: string;
    previewUrl: string;
    /** The cached Civitai record `M.decorate` puts on every row — page link and sample image. */
    civitai?: Record<string, unknown>;
}

const PAGE_SIZES = [24, 48, 96, 200];

/**
 * Lazy preview: aiohttp's add_get has no HEAD route, so probe with the <img> itself.
 * `fallbackSrc` is upstream's order (`helpers.js:33-57`): local preview, then the first Civitai
 * sample, then the placeholder — so a source change has to reset the probe, or the fallback's own
 * failure is never seen and the cell stays an empty <img>.
 */
function Thumb({ src, alt, fallbackSrc }: { src: string; alt: string; fallbackSrc?: string }): ReactElement {
    const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
    const [current, setCurrent] = useState(src);
    useEffect(() => {
        setCurrent(src);
        setState("idle");
    }, [src]);
    const failed = state === "fail";
    return (
        <span className={"nu-thumb" + (failed ? " nu-thumb--fail" : "")}>
            {!failed ? (
                <img
                    src={current}
                    alt={alt}
                    loading="lazy"
                    onLoad={() => setState("ok")}
                    onError={() => {
                        if (current === src && fallbackSrc) {
                            setCurrent(fallbackSrc);
                            setState("idle");
                            return;
                        }
                        setState("fail");
                    }}
                />
            ) : null}
            {failed ? <MdIcon>image_not_supported</MdIcon> : null}
        </span>
    );
}

/** Upstream's thumbnail fallback is `civitaiCache[sha256].images[0]` — a plain URL string. */
function civitaiSample(r: Record_): string | undefined {
    const images = (r.civitai as { images?: unknown } | undefined)?.images;
    const first = Array.isArray(images) ? images[0] : undefined;
    return typeof first === "string" && first ? first : undefined;
}

/** `M.civitaiUrl` gives null when neither a model nor a version id is cached, so no dead link. */
function civitaiHref(r: Record_): string | null {
    return r.civitai ? M.civitaiUrl(r.civitai as never) : null;
}

export default function Models({ navigate }: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [type, setType] = useState<string>("checkpoint");
    const [view, setView] = useState<ViewMode>(() =>
        readPref("models_view", "thumb") === "table" ? "table" : "thumb",
    );
    const [names, setNames] = useState<string[]>([]);
    const [metadata, setMetadata] = useState<Record<string, unknown>>({});
    const [groups, setGroups] = useState<Record<string, string[]>>({});
    const [disabled, setDisabled] = useState<Set<string>>(new Set());
    const [cache, setCache] = useState<Record<string, unknown>>({});
    const [palette, setPalette] = useState<Record<string, string>>(() => M.getBadgePalette());
    const [subdirs, setSubdirs] = useState<string[]>([]);

    const [search, setSearch] = useState("");
    const [tagFilter, setTagFilter] = useState("");
    const [badgeFilter, setBadgeFilter] = useState("");
    const [dirFilter, setDirFilter] = useState("");
    const [groupFilter, setGroupFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [favOnly, setFavOnly] = useState(false);
    const [batchOnly, setBatchOnly] = useState(false);
    const [sortKey, setSortKey] = useState<SortKey>("filename");
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(() => Number(readPref("models_page_size", 48)) || 48);

    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [detail, setDetail] = useState<Record_ | null>(null);
    const [bulkGroupName, setBulkGroupName] = useState("");
    const [newGroupName, setNewGroupName] = useState("");
    const [bulkBadgeName, setBulkBadgeName] = useState("");
    const [bulkDir, setBulkDir] = useState("");
    const [newDirName, setNewDirName] = useState("");
    const [cancelFetch, setCancelFetch] = useState<(() => void) | null>(null);
    const [loading, setLoading] = useState(false);
    const [civitaiProgress, setCivitaiProgress] = useState<{ current: number; total: number } | null>(null);

    const loadType = useCallback(
        async (modelType: string, keepSelection = false): Promise<void> => {
            setLoading(true);
            try {
                const [list, meta, grp, dis, civ, sub] = await Promise.all([
                    api.listModelFiles(modelType),
                    M.loadMetadata(),
                    M.loadGroups(modelType),
                    M.loadDisabled(modelType),
                    M.loadCivitaiCache(),
                    api.getSubdirs(modelType).catch(() => []),
                ]);
                setNames(Array.isArray(list) ? list : []);
                setMetadata(meta);
                setGroups(grp);
                setDisabled(dis);
                setCache(civ);
                setSubdirs(Array.isArray(sub) ? sub : []);
                // A type switch must drop the selection: the detail panel writes through `type` +
                // `detail.name`, so keeping a model from the previous type alive would group or
                // enable/disable a name that does not exist in this type (upstream nulls it on
                // every type change). A refresh of the *same* type keeps it — upstream's refresh
                // only refetches the listing.
                if (!keepSelection) {
                    setPage(0);
                    setSelected(new Set());
                    setDetail(null);
                }
            } catch (err) {
                snackbar.show({ label: (err as Error).message, tone: "error" });
            } finally {
                setLoading(false);
            }
        },
        [snackbar],
    );

    useEffect(() => {
        void loadType(type);
    }, [type, loadType]);

    const records = useMemo<Record_[]>(
        () => names.map((n) => M.decorate(type, n, metadata, { disabledSet: disabled, civitaiCache: cache, groups }) as Record_),
        [names, type, metadata, disabled, cache, groups],
    );

    const allTags = useMemo(() => M.aggregateTags(metadata, names), [metadata, names]);
    const allBadges = useMemo(
        () => M.aggregateBadges(metadata, names, palette),
        [metadata, names, palette],
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        let rows = records.filter((r) => {
            if (q && !r.name.toLowerCase().includes(q) && !r.memo.toLowerCase().includes(q)) return false;
            if (tagFilter && !r.tags.includes(tagFilter)) return false;
            if (badgeFilter && !r.badges.includes(badgeFilter)) return false;
            if (dirFilter && r.subdir !== dirFilter) return false;
            if (groupFilter && !r.groups.includes(groupFilter)) return false;
            if (statusFilter === "enabled" && !r.enabled) return false;
            if (statusFilter === "disabled" && r.enabled) return false;
            if (favOnly && !r.favorite) return false;
            if (batchOnly && !r.groups.includes("Batch")) return false;
            return true;
        });
        const dir = sortDir === "asc" ? 1 : -1;
        rows = [...rows].sort((a, b) => {
            const pick = (r: Record_): string | number => {
                switch (sortKey) {
                    case "fav":
                        return r.favorite ? 0 : 1;
                    case "filename":
                        return r.base;
                    case "subdir":
                        return r.subdir;
                    case "civtype":
                        return r.civType;
                    case "basemodel":
                        return r.baseModel;
                    case "ext":
                        return r.ext;
                    case "tags":
                        return r.tags.join(",");
                    case "memo":
                        return r.memo;
                    case "enabled":
                        return r.enabled ? 0 : 1;
                    default:
                        return r.base;
                }
            };
            const av = pick(a);
            const bv = pick(b);
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
            return String(av).localeCompare(String(bv)) * dir;
        });
        return rows;
    }, [records, search, tagFilter, badgeFilter, dirFilter, groupFilter, statusFilter, favOnly, batchOnly, sortKey, sortDir]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const slice = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

    const commitGroups = async (next: Record<string, string[]>): Promise<void> => {
        setGroups(next);
        await M.saveGroups(type, next);
    };

    const toggleSelect = (name: string): void => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const setFavorite = async (r: Record_): Promise<void> => {
        const next = M.toggleFavorite(metadata, r.name);
        const saved = await M.saveMetadata(r.name, { favorite: next.favorite });
        setMetadata((m) => ({ ...m, [r.name]: saved }));
    };

    const setEnabled = async (r: Record_, enabled: boolean): Promise<void> => {
        await M.setEnabled(type, r.name, enabled);
        setDisabled((prev) => {
            const next = new Set(prev);
            if (enabled) next.delete(r.name);
            else next.add(r.name);
            return next;
        });
    };

    const bulkFavorite = async (value: boolean): Promise<void> => {
        for (const name of selected) {
            const saved = await M.saveMetadata(name, { favorite: value });
            setMetadata((m) => ({ ...m, [name]: saved }));
        }
        snackbar.show({ label: `${selected.size} → ${value ? "★" : "☆"}` });
    };

    /**
     * §4 item 5's remove half: upstream deletes a group key once it is empty, except the reserved
     * Batch/Stack groups the loader always seeds (`selection-bulk.js:172-184`, `state.js:10`).
     */
    const pruneEmptyGroups = (next: Record<string, string[]>): Record<string, string[]> =>
        Object.fromEntries(Object.entries(next).filter(([g, list]) => list.length > 0 || MC.RESERVED_GROUPS.includes(g)));

    const bulkGroup = async (groupName: string, on: boolean): Promise<void> => {
        await commitGroups(pruneEmptyGroups(M.withMembers(groups, groupName, [...selected], on)));
    };

    /** §4 item 16/17: one badge select, two buttons — add and remove — like upstream's bulk bar. */
    const bulkBadgeSet = async (on: boolean): Promise<void> => {
        if (!bulkBadgeName || !selected.size) return;
        for (const name of selected) {
            const badges = M.withBadge(M.entryOf(metadata, name), bulkBadgeName, on);
            const saved = await M.saveMetadata(name, { badges });
            setMetadata((m) => ({ ...m, [name]: saved }));
        }
        snackbar.show({ label: `${selected.size} ${on ? "+" : "−"} ${bulkBadgeName}` });
    };

    /** §4 item 5: upstream offers a free-text "create a group and add" beside the picker. */
    const createAndAddGroup = async (): Promise<void> => {
        const name = newGroupName.trim();
        if (!name || !selected.size) return;
        await bulkGroup(name, true);
        setNewGroupName("");
        setBulkGroupName(name);
    };

    const bulkDelete = async (): Promise<void> => {
        if (!(await confirmDialog({ title: tr("nu.models.deleteConfirm", "Delete the selected model files?"), body: `${selected.size} file(s)`, danger: true, confirmLabel: tr("nu.action.delete", "Delete") }))) return;
        try {
            const res = (await api.deleteModels(type, [...selected])) as { errors?: unknown[] };
            snackbar.show({ label: `${tr("nu.models.deleted", "Deleted")} (${(res?.errors || []).length} errors)` });
            setSelected(new Set());
            await loadType(type);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    /**
     * Upstream's move has both a picker and a free-text folder, and `dest` "" *is* the model root
     * (`selection-bulk.js:104-115,271-278`; `py/services/models_service.py:390-405` rejects any
     * destination containing a separator, so nested paths are not offered). Moving renames every
     * key, so the listing reloads and the selection is dropped. Bulk writes ask first.
     */
    const bulkMove = async (dest: string): Promise<void> => {
        if (!selected.size) return;
        const label = dest || tr("nu.models.moveRoot", "(Root)");
        if (!(await confirmDialog({
            title: tr("nu.models.moveConfirm", "Move the selected models?"),
            body: `${selected.size} → ${label}`,
            confirmLabel: tr("nu.action.move", "Move"),
        }))) return;
        try {
            const res = (await api.moveModels(type, [...selected], dest)) as { moved?: unknown[]; errors?: unknown[] };
            snackbar.show({
                label: `${tr("nu.models.moved", "Moved")}: ${res?.moved?.length ?? 0}, ${tr("nu.models.errors", "errors")}: ${res?.errors?.length ?? 0}`,
            });
            setSelected(new Set());
            setNewDirName("");
            await loadType(type);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    /**
     * §4 item 13: Batch / Stack toggles go through core/batch.js so the Generate
     * view's batch panel sees the same selection. The group defs are kept in sync
     * locally for the group filter and the badge/summary rows.
     */
    const toggleReserved = async (groupName: string, r: Record_): Promise<void> => {
        const result = await (groupName === "Stack" ? B.toggleStack : B.toggleBatch)(
            getState().batch, type, r.name,
        );
        touchBatch();
        setGroups((prev) => ({ ...prev, [groupName]: result.members }));
        setDetail((d) => (d && d.name === r.name ? { ...d, groups: Object.entries({ ...groups, [groupName]: result.members })
            .filter(([, list]) => list.includes(r.name)).map(([g]) => g) } : d));
        snackbar.show({
            label: `${r.base} ${result.added ? "+" : "−"} ${groupName}`,
            actionLabel: tr("nu.batch.open", "Batch panel"),
            onAction: () => navigate("generate"),
        });
    };

    const clearReserved = async (groupName: string): Promise<void> => {
        const result = await (groupName === "Stack" ? B.clearStackGroup : B.clearBatchGroup)(getState().batch, type);
        touchBatch();
        setGroups((prev) => ({ ...prev, [groupName]: result.members }));
        snackbar.show({ label: `${groupName} ${tr("nu.models.cleared", "cleared")}` });
    };

    const fetchOne = async (r: Record_): Promise<void> => {
        try {
            const res = (await M.fetchCivitai(type, r.name)) as { sha256?: string; status?: string };
            if (res?.sha256) {
                const saved = await M.saveMetadata(r.name, { sha256: res.sha256 });
                setMetadata((m) => ({ ...m, [r.name]: saved }));
            }
            setCache(await M.loadCivitaiCache());
            snackbar.show({ label: `${r.name}: ${res?.status ?? "?"}` });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const fetchAll = async (): Promise<void> => {
        // Upstream skips models already in the Civitai cache and refuses an empty batch: the
        // route answers 400 for a nameless list, which the previous version guaranteed.
        const targets = filtered.filter((r) => !cache[r.name]);
        if (targets.length === 0) {
            snackbar.show({ label: tr("nu.models.civitaiAllCached", "Every model in this view already has cached Civitai metadata") });
            return;
        }
        const controller = new AbortController();
        setCancelFetch(() => controller.abort());
        setCivitaiProgress({ current: 0, total: targets.length });
        try {
            await M.batchFetchCivitai(
                type,
                targets.map((r) => r.name),
                (p: { current: number; total: number }) => setCivitaiProgress({ current: p.current, total: p.total }),
                controller.signal,
            );
            setCache(await M.loadCivitaiCache());
            setMetadata(await M.loadMetadata());
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setCivitaiProgress(null);
            setCancelFetch(null);
        }
    };

    /** §4 item 14: a pure core call + a store update, never a cross-view DOM poke. */
    const applyToGenerate = (r: Record_): void => {
        const target = M.genUiTarget(type);
        if (!target || target.mode !== "slot") {
            requestPromptAppend(M.appendEmbedding("", r.name));
            snackbar.show({
                label: `${M.embeddingPromptToken(r.name)} ${tr("nu.models.queuedPrompt", "appended in Generate")}`,
                actionLabel: tr("nu.action.open", "Open"),
                onAction: () => navigate("generate"),
            });
            return;
        }
        requestApply(type, { slot: target.slot, inputKey: target.inputKey, value: r.name });
        snackbar.show({
            label: `${r.name} → ${target.inputKey}`,
            actionLabel: tr("nu.action.open", "Open"),
            onAction: () => navigate("generate"),
        });
    };

    const switchView = (next: ViewMode): void => {
        setView(next);
        writePref("models_view", next);
    };

    /**
     * Upstream's "✕ Clear" (`models-tab.js:489-517`) resets search, tag, dir, group, status and the
     * two toggle chips plus the page, and leaves sort/view/select-mode alone. It also leaves
     * `badgeFilter` behind — a filter the button claims to clear but does not — so this resets it
     * too. Deliberate deviation, recorded in MIGRATION-NOTES §4.
     */
    const clearFilters = (): void => {
        setSearch("");
        setTagFilter("");
        setBadgeFilter("");
        setDirFilter("");
        setGroupFilter("");
        setStatusFilter("all");
        setFavOnly(false);
        setBatchOnly(false);
        setPage(0);
    };

    /** Upstream's refresh refetches the listing for the current type without losing the selection. */
    const refresh = (): void => {
        void loadType(type, true);
    };

    return (
        <div className="nu-view">
            <MdTabs aria-label={tr("nu.models.types", "Model types")}>
                {MC.MODEL_TYPES.map((t) => (
                    <MdPrimaryTab key={t} active={t === type} onClick={() => setType(t)}>
                        {(MC.TYPE_LABELS as Record<string, string>)[t] ?? t}
                    </MdPrimaryTab>
                ))}
            </MdTabs>

            {loading ? <MdLinearProgress indeterminate aria-label={tr("nu.common.loading", "Loading")} /> : null}
            {civitaiProgress ? (
                <div className="nu-row">
                    <MdLinearProgress
                        value={civitaiProgress.total ? civitaiProgress.current / civitaiProgress.total : 0}
                        aria-label={tr("nu.models.civitaiProgress", "Civitai metadata")}
                    />
                    {cancelFetch ? (
                        <MdOutlinedButton onClick={() => cancelFetch()}>
                            {tr("nu.action.cancel", "Cancel")}
                        </MdOutlinedButton>
                    ) : null}
                </div>
            ) : null}

            <div className="nu-view__toolbar">
                <MdOutlinedTextField
                    label={tr("nu.models.search", "Search")}
                    value={search}
                    onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                />
                <select className="nu-native-select" aria-label="tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                    <option value="">tag: *</option>
                    {allTags.map((t) => (
                        <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                <select className="nu-native-select" aria-label="badge" value={badgeFilter} onChange={(e) => setBadgeFilter(e.target.value)}>
                    <option value="">badge: *</option>
                    {allBadges.map((b) => (
                        <option key={b} value={b}>{b}</option>
                    ))}
                </select>
                <select className="nu-native-select" aria-label="dir" value={dirFilter} onChange={(e) => setDirFilter(e.target.value)}>
                    <option value="">dir: *</option>
                    {["", ...subdirs].map((d) => (
                        <option key={d || "root"} value={d}>{d || "."}</option>
                    ))}
                </select>
                <select className="nu-native-select" aria-label="group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
                    <option value="">group: *</option>
                    {Object.keys(groups).map((g) => (
                        <option key={g} value={g}>{g}</option>
                    ))}
                </select>
                <select className="nu-native-select" aria-label="status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    {MC.STATUS_FILTERS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                    ))}
                </select>
                <MdFilterChip label="★" selected={favOnly} onInput={() => setFavOnly((v) => !v)} />
                <MdFilterChip label="Batch" selected={batchOnly} onInput={() => setBatchOnly((v) => !v)} />
                {MC.isBatchType(type) && (groups.Batch?.length ?? 0) > 0 ? (
                    <MdTextButton onClick={() => void clearReserved("Batch")}>
                        {tr("nu.models.clearBatch", "clear Batch")} ({groups.Batch?.length})
                    </MdTextButton>
                ) : null}
                {MC.isStackType(type) && (groups.Stack?.length ?? 0) > 0 ? (
                    <MdTextButton onClick={() => void clearReserved("Stack")}>
                        {tr("nu.models.clearStack", "clear Stack")} ({groups.Stack?.length})
                    </MdTextButton>
                ) : null}
                <MdFilterChip
                    label={view === "thumb" ? "grid" : "table"}
                    onInput={() => switchView(view === "thumb" ? "table" : "thumb")}
                />
                <MdFilterChip
                    label={selectMode ? "select: on" : "select: off"}
                    selected={selectMode}
                    onInput={() => {
                        setSelectMode((v) => !v);
                        setSelected(new Set());
                    }}
                />
                {/* §4 filters were undoable one select at a time only, and a stale listing needed a
                    page reload — upstream has both controls (`models-tab.js:489,539`). */}
                <MdOutlinedButton onClick={clearFilters}>
                    <MdIcon slot="icon">clear</MdIcon>
                    {tr("nu.models.clearFilters", "Clear")}
                </MdOutlinedButton>
                <MdOutlinedButton onClick={refresh} disabled={loading}>
                    <MdIcon slot="icon">refresh</MdIcon>
                    {tr("nu.action.reload", "Reload")}
                </MdOutlinedButton>
                <select
                    className="nu-native-select"
                    aria-label="page size"
                    value={String(pageSize)}
                    onChange={(e) => {
                        const n = Number(e.target.value) || 48;
                        setPageSize(n);
                        writePref("models_page_size", n);
                        setPage(0);
                    }}
                >
                    {PAGE_SIZES.map((n) => (
                        <option key={n} value={String(n)}>{n}/page</option>
                    ))}
                </select>
                <MdFilledButton onClick={() => void fetchAll()}>{tr("nu.models.civitaiAll", "Fetch Civitai")}</MdFilledButton>
            </div>

            {selectMode ? (
                <div className="nu-view__toolbar">
                    <MdCheckbox checked={selected.size === filtered.length && filtered.length > 0} onChange={() => setSelected(new Set(filtered.map((r) => r.name)))} />
                    <MdTextButton onClick={() => setSelected(new Set())}>{tr("nu.models.clear", "Clear")}</MdTextButton>
                    <span className="nu-muted">{selected.size} / {filtered.length}</span>
                    <MdOutlinedButton disabled={!selected.size} onClick={() => void bulkFavorite(true)}>★</MdOutlinedButton>
                    <MdOutlinedButton disabled={!selected.size} onClick={() => void bulkFavorite(false)}>☆</MdOutlinedButton>
                    <select
                        className="nu-native-select"
                        aria-label={tr("nu.models.bulkGroupLabel", "Group")}
                        value={bulkGroupName}
                        onChange={(e) => setBulkGroupName(e.target.value)}
                    >
                        <option value="">{tr("nu.models.pickGroup", "pick group…")}</option>
                        {Object.keys(groups).map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <MdOutlinedButton disabled={!selected.size || !bulkGroupName} onClick={() => void bulkGroup(bulkGroupName, true)}>
                        {tr("nu.action.add", "Add")}
                    </MdOutlinedButton>
                    <MdOutlinedButton disabled={!selected.size || !bulkGroupName} onClick={() => void bulkGroup(bulkGroupName, false)}>
                        {tr("nu.action.remove", "Remove")}
                    </MdOutlinedButton>
                    <input
                        className="nu-native-select"
                        type="text"
                        aria-label={tr("nu.models.newGroup", "New group name")}
                        placeholder={tr("nu.models.newGroup", "New group name")}
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                    />
                    <MdOutlinedButton disabled={!selected.size || !newGroupName.trim()} onClick={() => void createAndAddGroup()}>
                        {tr("nu.models.createAdd", "Create & add")}
                    </MdOutlinedButton>
                    <select
                        className="nu-native-select"
                        aria-label={tr("nu.models.bulkBadgeLabel", "Badge")}
                        value={bulkBadgeName}
                        onChange={(e) => setBulkBadgeName(e.target.value)}
                    >
                        <option value="">{tr("nu.models.pickBadge", "pick badge…")}</option>
                        {allBadges.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    {/* Upstream pairs one badge select with an add *and* a remove button
                        (`selection-bulk.js:141-148`); here the badge could only be added. */}
                    <MdOutlinedButton disabled={!selected.size || !bulkBadgeName} onClick={() => void bulkBadgeSet(true)}>
                        {tr("nu.action.add", "Add")}
                    </MdOutlinedButton>
                    <MdOutlinedButton disabled={!selected.size || !bulkBadgeName} onClick={() => void bulkBadgeSet(false)}>
                        {tr("nu.action.remove", "Remove")}
                    </MdOutlinedButton>
                    <select
                        className="nu-native-select"
                        aria-label={tr("nu.models.bulkMoveLabel", "Move to folder")}
                        value={bulkDir}
                        onChange={(e) => setBulkDir(e.target.value)}
                    >
                        <option value="">{tr("nu.models.moveRoot", "(Root)")}</option>
                        {subdirs.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <MdOutlinedButton disabled={!selected.size} onClick={() => void bulkMove(bulkDir)}>
                        {tr("nu.action.move", "Move")}
                    </MdOutlinedButton>
                    {/* §4 item 18: a folder that does not exist yet was not offerable, so the only
                        destination ever reachable was an existing subdir or the root. */}
                    <input
                        className="nu-native-select"
                        type="text"
                        aria-label={tr("nu.models.newDir", "New folder name")}
                        placeholder={tr("nu.models.newDir", "New folder name")}
                        value={newDirName}
                        onChange={(e) => setNewDirName(e.target.value)}
                    />
                    <MdOutlinedButton disabled={!selected.size || !newDirName.trim()} onClick={() => void bulkMove(newDirName.trim())}>
                        {tr("nu.models.createMove", "Create & move")}
                    </MdOutlinedButton>
                    <MdOutlinedButton disabled={!selected.size} onClick={() => void bulkDelete()}>
                        {tr("nu.action.delete", "Delete")}
                    </MdOutlinedButton>
                </div>
            ) : null}

            <div className="nu-models">
                <div className="nu-models__list">
                    {filtered.length === 0 ? (
                        /* One placeholder for both "this type is empty" and "nothing matches",
                           before the view branch — exactly upstream's guard (`grid-view.js:39-42`). */
                        <p className="nu-placeholder">{tr("nu.models.noneFound", "No models found")}</p>
                    ) : view === "thumb" ? (
                        <div className="nu-grid">
                            {slice.map((r) => (
                                <MdOutlinedCard key={r.name}>
                                    <button type="button" className="nu-card__hit" onClick={() => (selectMode ? toggleSelect(r.name) : setDetail(r))}>
                                        <Thumb src={r.previewUrl} alt={r.base} fallbackSrc={civitaiSample(r)} />
                                        <span className="nu-card__name">{r.base}</span>
                                        <span className="nu-chip-row">
                                            {r.badges.map((b) => (
                                                <span key={b} className="nu-badge" style={{ "--badge-color": M.badgeColor(palette, b) ?? "" } as CSSProperties}>{b}</span>
                                            ))}
                                        </span>
                                    </button>
                                    <div className="nu-row">
                                        <MdIcon aria-hidden="true">{r.favorite ? "star" : "star_border"}</MdIcon>
                                        <MdTextButton onClick={() => void setFavorite(r)}>★</MdTextButton>
                                        <MdSwitch selected={r.enabled} aria-label="enabled" onChange={() => void setEnabled(r, !r.enabled)} />
                                        {/* §4 item 13: only checkpoints join Batch and only LoRAs
                                            stack (MC.isBatchType/isStackType) — a chip rendered for a
                                            type whose group the loader never seeds strands the file. */}
                                        {MC.isBatchType(type) ? (
                                            <MdFilterChip
                                                label="Batch"
                                                selected={(groups.Batch ?? []).includes(r.name)}
                                                onInput={() => void toggleReserved("Batch", r)}
                                            />
                                        ) : null}
                                        {MC.isStackType(type) ? (
                                            <MdFilterChip
                                                label="Stack"
                                                selected={(groups.Stack ?? []).includes(r.name)}
                                                onInput={() => void toggleReserved("Stack", r)}
                                            />
                                        ) : null}
                                    </div>
                                </MdOutlinedCard>
                            ))}
                        </div>
                    ) : (
                        <div className="nu-table-wrap">
                            <table className="nu-table">
                                <thead>
                                    <tr>
                                        <th />
                                        {MC.SORT_COLUMNS.map((col) => (
                                            <th key={col} aria-sort={sortKey === col ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                                                <button
                                                    type="button"
                                                    className="nu-table__sort"
                                                    onClick={() => {
                                                        if (sortKey === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                                                        else {
                                                            setSortKey(col);
                                                            setSortDir("asc");
                                                        }
                                                    }}
                                                >
                                                    {col}
                                                    {sortKey === col ? <MdIcon>{sortDir === "asc" ? "arrow_upward" : "arrow_downward"}</MdIcon> : null}
                                                </button>
                                            </th>
                                        ))}
                                        {/* Upstream gates the B/S *columns* by type, header included
                                            (`grid-view.js:149-151`): showBatchBtn = checkpoint|lora,
                                            showStackBtn = lora. Same conditions as the grid's chips. */}
                                        {MC.isBatchType(type) ? <th aria-label={tr("nu.models.batchCol", "Batch column")}>B</th> : null}
                                        {MC.isStackType(type) ? <th aria-label={tr("nu.models.stackCol", "Stack column")}>S</th> : null}
                                    </tr>
                                </thead>
                                <tbody>
                                    {slice.map((r) => (
                                        <tr key={r.name} data-selected={selected.has(r.name)} onClick={() => (selectMode ? toggleSelect(r.name) : setDetail(r))}>
                                            <td>{selectMode ? <MdCheckbox checked={selected.has(r.name)} onChange={() => toggleSelect(r.name)} /> : <Thumb src={r.previewUrl} alt={r.base} fallbackSrc={civitaiSample(r)} />}</td>
                                            {/* §4 items 12/13: the table row had no controls of its own —
                                                a static ★ and an "on"/"off" label — so favouriting, disabling
                                                and Batch/Stack all needed grid view. Upstream wires all four
                                                into the row (`grid-view.js:175-186,222-243`), and each one
                                                stops the row click from opening the panel. */}
                                            <td>
                                                <button
                                                    type="button"
                                                    className="nu-table__act"
                                                    title={tr("nu.models.favorite", "Favorite")}
                                                    aria-label={tr("nu.models.favorite", "Favorite")}
                                                    onClick={(e) => { e.stopPropagation(); void setFavorite(r); }}
                                                >
                                                    {r.favorite ? "★" : "☆"}
                                                </button>
                                            </td>
                                            <td dangerouslySetInnerHTML={{ __html: escapeHtml(r.base) }} />
                                            <td>{r.subdir || "."}</td>
                                            <td>{r.civType}</td>
                                            <td>{r.baseModel}</td>
                                            <td>{r.ext}</td>
                                            <td>{r.tags.join(", ")}</td>
                                            <td>{r.memo}</td>
                                            <td>
                                                <button
                                                    type="button"
                                                    className={"nu-table__act" + (r.enabled ? "" : " nu-table__act--off")}
                                                    title={r.enabled ? tr("nu.action.disable", "Disable") : tr("nu.action.enable", "Enable")}
                                                    aria-label={r.enabled ? tr("nu.action.disable", "Disable") : tr("nu.action.enable", "Enable")}
                                                    onClick={(e) => { e.stopPropagation(); void setEnabled(r, !r.enabled); }}
                                                >
                                                    {r.enabled ? "⏸" : "▶"}
                                                </button>
                                            </td>
                                            {MC.isBatchType(type) ? (
                                                <td>
                                                    <button
                                                        type="button"
                                                        className={"nu-table__act" + ((groups.Batch ?? []).includes(r.name) ? " nu-table__act--on" : "")}
                                                        title={tr("nu.models.batch", "Batch")}
                                                        aria-label={tr("nu.models.batch", "Batch")}
                                                        onClick={(e) => { e.stopPropagation(); void toggleReserved("Batch", r); }}
                                                    >
                                                        B
                                                    </button>
                                                </td>
                                            ) : null}
                                            {MC.isStackType(type) ? (
                                                <td>
                                                    <button
                                                        type="button"
                                                        className={"nu-table__act" + ((groups.Stack ?? []).includes(r.name) ? " nu-table__act--on" : "")}
                                                        title={tr("nu.models.stack", "Stack")}
                                                        aria-label={tr("nu.models.stack", "Stack")}
                                                        onClick={(e) => { e.stopPropagation(); void toggleReserved("Stack", r); }}
                                                    >
                                                        S
                                                    </button>
                                                </td>
                                            ) : null}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="nu-row">
                        <MdOutlinedButton disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</MdOutlinedButton>
                        <span className="nu-muted">{safePage + 1} / {pageCount} · {filtered.length}</span>
                        <MdOutlinedButton disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>›</MdOutlinedButton>
                    </div>
                </div>

                {detail ? (
                    <MdOutlinedCard className="nu-detail">
                        <div className="nu-card__head">
                            <h2 className="nu-card__title">{detail.base}</h2>
                            <MdTextButton onClick={() => setDetail(null)}>close</MdTextButton>
                        </div>
                        <MdDivider />
                        <div className="nu-card__body">
                            <p className="nu-muted">{detail.name}</p>
                            <p className="nu-muted">{detail.ext} · {detail.subdir || "."}</p>
                            <div className="nu-chip-row">
                                {detail.groups.map((g) => (
                                    <MdFilterChip key={g} label={g} selected onInput={() => void commitGroups(pruneEmptyGroups(M.withMembers(groups, g, [detail.name], false)))} />
                                ))}
                            </div>
                            <MdOutlinedTextField
                                label="tags"
                                value={detail.tags.join(", ")}
                                onInput={(e) =>
                                    void (async () => {
                                        const tags = (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean);
                                        const saved = await M.saveMetadata(detail.name, { tags });
                                        setMetadata((m) => ({ ...m, [detail.name]: saved }));
                                    })()
                                }
                            />
                            <MdOutlinedTextField
                                label="memo"
                                value={detail.memo}
                                onInput={(e) =>
                                    void (async () => {
                                        const saved = await M.saveMetadata(detail.name, { memo: (e.target as HTMLInputElement).value });
                                        setMetadata((m) => ({ ...m, [detail.name]: saved }));
                                    })()
                                }
                            />
                            <select className="nu-native-select" aria-label="group" defaultValue="" onChange={(e) => e.target.value && void commitGroups(M.withMembers(groups, e.target.value, [detail.name], true))}>
                                <option value="">+ group…</option>
                                {Object.keys(groups).map((g) => <option key={g} value={g}>{g}</option>)}
                            </select>
                            <div className="nu-row">
                                <MdFilledButton onClick={() => applyToGenerate(detail)}>{tr("nu.models.apply", "Apply to Generate")}</MdFilledButton>
                                {/* Upstream's second embedding button, gated to the `embedding` type
                                    (`models-tab.js:575-579`, `detail-panel.js:255-263`): every other type
                                    lands in a node slot, so there is no negative field to append to. */}
                                {type === "embedding" ? (
                                    <MdOutlinedButton
                                        onClick={() => {
                                            requestPromptAppend(detail.name, "negative");
                                            snackbar.show({
                                                label: `${M.embeddingPromptToken(detail.name)} ${tr("nu.models.queuedNegative", "queued for the negative prompt")}`,
                                                actionLabel: tr("nu.action.open", "Open"),
                                                onAction: () => navigate("generate"),
                                            });
                                        }}
                                    >
                                        {tr("nu.models.applyNegative", "Apply to negative")}
                                    </MdOutlinedButton>
                                ) : null}
                                <MdOutlinedButton onClick={() => void fetchOne(detail)}>Civitai</MdOutlinedButton>
                                <MdOutlinedButton onClick={() => void setEnabled(detail, !detail.enabled)}>{detail.enabled ? "disable" : "enable"}</MdOutlinedButton>
                            </div>
                            {detail.sha256 ? <p className="nu-muted">sha256 {detail.sha256.slice(0, 16)}…</p> : null}
                            {/* §4 item 10: the cache was reduced to a truncated sha. The link is
                                `M.civitaiUrl`'s three branches, and no link at all when neither a
                                model nor a version id is cached (upstream falls back to "#"). */}
                            {civitaiHref(detail) ? (
                                <a className="nu-link" href={civitaiHref(detail) ?? "#"} target="_blank" rel="noopener noreferrer">
                                    {tr("nu.models.civitaiPage", "Civitai page")}
                                </a>
                            ) : null}
                            <Thumb src={detail.previewUrl} alt={detail.base} fallbackSrc={civitaiSample(detail)} />
                        </div>
                    </MdOutlinedCard>
                ) : null}
            </div>

            <MdChipSet>
                {Object.entries(palette).map(([label, color]) => (
                    <MdFilterChip
                        key={label}
                        label={`${label} ${color}`}
                        onInput={() => {
                            const next = { ...palette };
                            delete next[label];
                            setPalette(next);
                            M.saveBadgePalette(next);
                        }}
                    />
                ))}
                <MdOutlinedButton
                    onClick={async () => {
                        const label = await promptDialog({ title: tr("nu.models.badgeLabel", "New badge label") });
                        if (!label) return;
                        const color = await promptDialog({
                            title: tr("nu.models.badgeColor", "Badge colour"),
                            body: tr("nu.models.badgeColorHint", "Any CSS colour value; it is applied to the badge text."),
                            value: "currentColor",
                        });
                        const next = { ...palette, [label]: color ?? "currentColor" };
                        setPalette(next);
                        M.saveBadgePalette(next);
                    }}
                >
                    + badge
                </MdOutlinedButton>
            </MdChipSet>
        </div>
    );
}
