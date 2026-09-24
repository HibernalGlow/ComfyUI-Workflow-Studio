import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdTextButton,
    MdOutlinedTextField,
    MdOutlinedCard,
    MdLinearProgress,
    MdIcon,
    MdCheckbox,
    MdFilterChip,
} from "../md.js";
import { useSnackbar } from "../snackbar.js";
import { confirmDialog } from "../dialogs.js";
import { requestWorkflow } from "../store.js";
import { api, tr } from "core";
import type { ViewProps } from "../App.js";

interface Shot {
    filename: string;
    path: string;
    ext?: string;
    favorite?: boolean;
    tags?: string[];
    memo?: string;
    groups?: string[];
}

interface FolderNode {
    name: string;
    path: string;
    image_count?: number;
    children?: FolderNode[];
}

export default function Gallery({ navigate }: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [root, setRoot] = useState("");
    const [tree, setTree] = useState<FolderNode[]>([]);
    const [folder, setFolder] = useState("");
    const [images, setImages] = useState<Shot[]>([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState("");
    const [favOnly, setFavOnly] = useState(false);
    const [loading, setLoading] = useState(false);
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [preview, setPreview] = useState<Shot | null>(null);
    const [previewWorkflow, setPreviewWorkflow] = useState<string | null>(null);
    const [groups, setGroups] = useState<string[]>([]);

    const loadTree = useCallback(
        async (dir: string): Promise<void> => {
            try {
                const node = (await api.listGalleryFolders(dir || undefined)) as FolderNode;
                setTree(Array.isArray(node?.children) ? node.children : []);
            } catch (err) {
                snackbar.show({ label: (err as Error).message, tone: "error" });
            }
        },
        [snackbar],
    );

    const loadImages = useCallback(
        async (): Promise<void> => {
            if (!folder) return;
            setLoading(true);
            try {
                const res = (await api.listGalleryImages({
                    folder,
                    search: search || undefined,
                    favorite: favOnly ? "1" : undefined,
                    recursive: "1",
                })) as { images?: Shot[]; total?: number };
                setImages(Array.isArray(res?.images) ? res.images : []);
                setTotal(Number(res?.total ?? 0));
                setSelected(new Set());
            } catch (err) {
                snackbar.show({ label: (err as Error).message, tone: "error" });
            } finally {
                setLoading(false);
            }
        },
        [folder, search, favOnly, snackbar],
    );

    useEffect(() => {
        void (async () => {
            const dir = await api.getOutputDir().catch(() => ({ current: "" }));
            const start = String((dir as { current?: string })?.current ?? "");
            setRoot(start);
            await loadTree(start);
            void api.listGalleryGroups().then((g) => {
                setGroups(Array.isArray(g) ? (g as string[]) : Object.keys((g as Record<string, unknown>) || {}));
            }).catch(() => undefined);
        })();
    }, [loadTree]);

    useEffect(() => {
        void loadImages();
    }, [loadImages]);

    const openShot = async (shot: Shot): Promise<void> => {
        setPreview(shot);
        setPreviewWorkflow(null);
        try {
            const res = (await api.getGalleryImageWorkflow(shot.path)) as {
                workflow?: unknown;
                has_workflow?: boolean;
            };
            if (res?.has_workflow) setPreviewWorkflow(JSON.stringify(res.workflow, null, 2));
        } catch {
            setPreviewWorkflow(null);
        }
    };

    const restoreWorkflow = (): void => {
        if (!preview || !previewWorkflow) return;
        requestWorkflow(preview.path, previewWorkflow);
        navigate("workflow");
        snackbar.show({ label: tr("nu.gallery.restored", "Workflow handed to the Workflow view.") });
    };

    const toggleFav = async (shot: Shot): Promise<void> => {
        try {
            await api.toggleGalleryFavorite(shot.path);
            setImages((prev) =>
                prev.map((i) => (i.path === shot.path ? { ...i, favorite: !i.favorite } : i)),
            );
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const bulkFav = async (value: boolean): Promise<void> => {
        try {
            await api.bulkGalleryFavorite([...selected], value);
            await loadImages();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const removeSelected = async (): Promise<void> => {
        if (!(await confirmDialog({ title: tr("nu.gallery.deleteConfirm", "Delete the selected images?"), body: `${selected.size} →`, danger: true, confirmLabel: tr("nu.action.delete", "Delete") }))) return;
        try {
            await api.deleteGalleryImages([...selected]);
            await loadImages();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const saveToGroup = async (group: string): Promise<void> => {
        if (!group) return;
        try {
            await api.bulkGalleryGroup([...selected], group, "add");
            await loadImages();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const flat = useMemo(() => {
        const walk = (nodes: FolderNode[], depth: number): Array<{ node: FolderNode; depth: number }> =>
            nodes.flatMap((n) => [{ node: n, depth }, ...walk(n.children ?? [], depth + 1)]);
        return walk(tree, 0);
    }, [tree]);

    return (
        <div className="nu-view">
            <div className="nu-view__toolbar">
                <MdOutlinedTextField
                    label={tr("nu.gallery.search", "Search")}
                    value={search}
                    onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                />
                <MdFilterChip label="★" selected={favOnly} onInput={() => setFavOnly((v) => !v)} />
                <MdFilterChip
                    label={selectMode ? "select: on" : "select: off"}
                    selected={selectMode}
                    onInput={() => {
                        setSelectMode((v) => !v);
                        setSelected(new Set());
                    }}
                />
                <MdOutlinedButton onClick={() => void loadImages()}>
                    <MdIcon slot="icon">refresh</MdIcon>
                    {tr("nu.action.reload", "Reload")}
                </MdOutlinedButton>
                <span className="nu-muted">{images.length} / {total}</span>
            </div>

            {selectMode ? (
                <div className="nu-view__toolbar">
                    <MdCheckbox
                        checked={selected.size === images.length && images.length > 0}
                        onChange={() =>
                            setSelected(
                                selected.size === images.length
                                    ? new Set()
                                    : new Set(images.map((i) => i.path)),
                            )
                        }
                    />
                    <MdTextButton onClick={() => void bulkFav(true)}>★ all</MdTextButton>
                    <MdTextButton onClick={() => void bulkFav(false)}>☆ all</MdTextButton>
                    <select className="nu-native-select" aria-label="group" defaultValue="" onChange={(e) => void saveToGroup(e.target.value)}>
                        <option value="">+ group…</option>
                        {groups.map((g) => (
                            <option key={g} value={g}>{g}</option>
                        ))}
                    </select>
                    <MdTextButton onClick={() => void removeSelected()}>{tr("nu.action.delete", "Delete")}</MdTextButton>
                    <span className="nu-muted">{selected.size}</span>
                </div>
            ) : null}

            {loading ? <MdLinearProgress indeterminate aria-label={tr("nu.common.loading", "Loading")} /> : null}

            <div className="nu-split">
                <MdOutlinedCard className="nu-list-panel">
                    <div className="nu-row">
                        <MdTextButton onClick={() => void loadTree(root)}>{tr("nu.gallery.root", "Root")}</MdTextButton>
                    </div>
                    {flat.map(({ node, depth }) => (
                        <button
                            key={node.path || node.name}
                            type="button"
                            className={"nu-file" + (node.path === folder ? " nu-file--active" : "")}
                            style={{ paddingInlineStart: `${8 + depth * 14}px` }}
                            onClick={() => setFolder(node.path)}
                        >
                            <MdIcon>folder</MdIcon>
                            <span className="nu-file__name">{node.name}</span>
                            <span className="nu-muted">{node.image_count ?? 0}</span>
                        </button>
                    ))}
                </MdOutlinedCard>

                <div className="nu-grid">
                    {images.map((shot) => (
                        <figure key={shot.path} className="nu-shot">
                            <button type="button" className="nu-shot__hit" onClick={() => (selectMode ? setSelected((p) => {
                                const n = new Set(p);
                                if (n.has(shot.path)) n.delete(shot.path);
                                else n.add(shot.path);
                                return n;
                            }) : void openShot(shot))}>
                                <img src={api.galleryThumbUrl(shot.path, 320)} alt={shot.filename} loading="lazy" />
                            </button>
                            <figcaption className="nu-row">
                                <MdTextButton onClick={() => void toggleFav(shot)}>
                                    {shot.favorite ? "★" : "☆"}
                                </MdTextButton>
                                <span className="nu-muted">{shot.filename}</span>
                            </figcaption>
                        </figure>
                    ))}
                </div>
            </div>

            {preview ? (
                <MdOutlinedCard>
                    <div className="nu-card__head">
                        <h2 className="nu-card__title">{preview.filename}</h2>
                        <span className="nu-spacer" />
                        <MdFilledButton disabled={!previewWorkflow} onClick={restoreWorkflow}>
                            {tr("nu.gallery.useWorkflow", "Restore workflow")}
                        </MdFilledButton>
                        <MdTextButton onClick={() => setPreview(null)}>close</MdTextButton>
                    </div>
                    <div className="nu-card__body">
                        <img className="nu-shot__full" src={api.galleryServeUrl(preview.path)} alt={preview.filename} />
                        {previewWorkflow ? <pre className="nu-pre">{previewWorkflow.slice(0, 4000)}</pre> : (
                            <p className="nu-muted">{tr("nu.gallery.noWorkflow", "This image carries no embedded workflow.")}</p>
                        )}
                    </div>
                </MdOutlinedCard>
            ) : null}
        </div>
    );
}
