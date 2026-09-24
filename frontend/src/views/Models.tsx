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
}

const PAGE_SIZES = [24, 48, 96, 200];

/** Lazy preview: aiohttp's add_get has no HEAD route, so probe with the <img> itself. */
function Thumb({ src, alt }: { src: string; alt: string }): ReactElement {
    const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
    return (
        <span className={"nu-thumb" + (state === "fail" ? " nu-thumb--fail" : "")}>
            {state !== "fail" ? (
                <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    onLoad={() => setState("ok")}
                    onError={() => setState("fail")}
                />
            ) : null}
            {state === "fail" ? <MdIcon>image_not_supported</MdIcon> : null}
        </span>
    );
}

export default function Models(_props: ViewProps): ReactElement {
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
    const [loading, setLoading] = useState(false);
    const [civitaiProgress, setCivitaiProgress] = useState<{ current: number; total: number } | null>(null);

    const loadType = useCallback(
        async (modelType: string): Promise<void> => {
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
                setPage(0);
                setSelected(new Set());
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

    const bulkBadge = async (badge: string, on: boolean): Promise<void> => {
        for (const name of selected) {
            const badges = M.withBadge(M.entryOf(metadata, name), badge, on);
            const saved = await M.saveMetadata(name, { badges });
            setMetadata((m) => ({ ...m, [name]: saved }));
        }
    };

    const bulkGroup = async (groupName: string, on: boolean): Promise<void> => {
        await commitGroups(M.withMembers(groups, groupName, [...selected], on));
    };

    const bulkDelete = async (): Promise<void> => {
        if (!window.confirm(tr("nu.models.deleteConfirm", "Delete the selected model files?"))) return;
        try {
            const res = (await api.deleteModels(type, [...selected])) as { errors?: unknown[] };
            snackbar.show({ label: `${tr("nu.models.deleted", "Deleted")} (${(res?.errors || []).length} errors)` });
            setSelected(new Set());
            await loadType(type);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const bulkMove = async (dest: string): Promise<void> => {
        try {
            await api.moveModels(type, [...selected], dest);
            await loadType(type);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const toggleBatchGroup = (r: Record_): void => {
        const on = !(groups.Batch || []).includes(r.name);
        void commitGroups(M.withMembers(groups, "Batch", [r.name], on)).then(() => {
            setGroups((g) => M.withMembers(g, "Batch", [r.name], on));
        });
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
        const controller = new AbortController();
        setCivitaiProgress({ current: 0, total: filtered.length });
        try {
            await M.batchFetchCivitai(
                type,
                filtered.map((r) => r.name),
                (p: { current: number; total: number }) => setCivitaiProgress({ current: p.current, total: p.total }),
                controller.signal,
            );
            setCache(await M.loadCivitaiCache());
            setMetadata(await M.loadMetadata());
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setCivitaiProgress(null);
        }
    };

    const applyToGenerate = (r: Record_): void => {
        const target = M.genUiTarget(type);
        if (!target || target.mode !== "slot") {
            window.localStorage.setItem("nu_pending_embedding", r.name);
            snackbar.show({ label: tr("nu.models.embeddingQueued", "Embedding queued for the prompt.") });
            return;
        }
        window.localStorage.setItem(
            "nu_pending_apply",
            JSON.stringify({ slot: target.slot, inputKey: target.inputKey, value: r.name }),
        );
        snackbar.show({ label: `${r.name} → ${target.slot}` });
    };

    const switchView = (next: ViewMode): void => {
        setView(next);
        writePref("models_view", next);
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

            {loading ? <MdLinearProgress indeterminate /> : null}
            {civitaiProgress ? (
                <MdLinearProgress value={civitaiProgress.total ? civitaiProgress.current / civitaiProgress.total : 0} />
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
                    <select className="nu-native-select" aria-label="bulk group" defaultValue="" onChange={(e) => { if (e.target.value && selected.size) void bulkGroup(e.target.value, true); }}>
                        <option value="">+ group…</option>
                        {Object.keys(groups).map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <select className="nu-native-select" aria-label="bulk badge" defaultValue="" onChange={(e) => { if (e.target.value && selected.size) void bulkBadge(e.target.value, true); }}>
                        <option value="">+ badge…</option>
                        {allBadges.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <select className="nu-native-select" aria-label="bulk move" defaultValue="" onChange={(e) => { if (selected.size && e.target.value !== "") void bulkMove(e.target.value); }}>
                        <option value="">move…</option>
                        <option value=".">root</option>
                        {subdirs.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <MdOutlinedButton disabled={!selected.size} onClick={() => void bulkDelete()}>
                        {tr("nu.action.delete", "Delete")}
                    </MdOutlinedButton>
                </div>
            ) : null}

            <div className="nu-models">
                <div className="nu-models__list">
                    {view === "thumb" ? (
                        <div className="nu-grid">
                            {slice.map((r) => (
                                <MdOutlinedCard key={r.name}>
                                    <button type="button" className="nu-card__hit" onClick={() => (selectMode ? toggleSelect(r.name) : setDetail(r))}>
                                        <Thumb src={r.previewUrl} alt={r.base} />
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
                                        <MdTextButton onClick={() => toggleBatchGroup(r)}>Batch</MdTextButton>
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
                                    </tr>
                                </thead>
                                <tbody>
                                    {slice.map((r) => (
                                        <tr key={r.name} data-selected={selected.has(r.name)} onClick={() => (selectMode ? toggleSelect(r.name) : setDetail(r))}>
                                            <td>{selectMode ? <MdCheckbox checked={selected.has(r.name)} onChange={() => toggleSelect(r.name)} /> : <Thumb src={r.previewUrl} alt={r.base} />}</td>
                                            <td>{r.favorite ? "★" : ""}</td>
                                            <td dangerouslySetInnerHTML={{ __html: escapeHtml(r.base) }} />
                                            <td>{r.subdir || "."}</td>
                                            <td>{r.civType}</td>
                                            <td>{r.baseModel}</td>
                                            <td>{r.ext}</td>
                                            <td>{r.tags.join(", ")}</td>
                                            <td>{r.memo}</td>
                                            <td>{r.enabled ? "on" : "off"}</td>
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
                                    <MdFilterChip key={g} label={g} selected onInput={() => void commitGroups(M.withMembers(groups, g, [detail.name], false))} />
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
                                <MdOutlinedButton onClick={() => void fetchOne(detail)}>Civitai</MdOutlinedButton>
                                <MdOutlinedButton onClick={() => void setEnabled(detail, !detail.enabled)}>{detail.enabled ? "disable" : "enable"}</MdOutlinedButton>
                            </div>
                            {detail.sha256 ? <p className="nu-muted">sha256 {detail.sha256.slice(0, 16)}…</p> : null}
                            <Thumb src={detail.previewUrl} alt={detail.base} />
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
                    onClick={() => {
                        const label = window.prompt("badge label");
                        if (!label) return;
                        const color = window.prompt("badge colour (any CSS colour)", "currentColor") || "currentColor";
                        const next = { ...palette, [label]: color };
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
