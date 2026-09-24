/**
 * Batch panel — the UI half of the batch-selection state machine in core/batch.js
 * (parity item 8, and §4 item 13's Batch/Stack toggles shared with the Models view).
 *
 * Every mutation goes through a core helper and then `touchBatch()`, so the Models
 * view and this panel read one state object rather than two mirrors.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdTextButton,
    MdCheckbox,
    MdLinearProgress,
    MdDivider,
    MdIcon,
} from "./md.js";
import { batch as B, comfyUI, api, tr } from "core";
import { getState, touchBatch } from "./store.js";
import { useSnackbar } from "./snackbar.js";

type BatchType = "checkpoint" | "lora" | "prompt" | "workflow" | "sampler" | "scheduler" | "style";
type SimpleKey = "samplers" | "schedulers" | "styles";

const TYPES: BatchType[] = ["lora", "checkpoint", "prompt", "workflow", "sampler", "scheduler", "style"];

/** core stores the flat lists under plural state keys. */
const SIMPLE_KEY: Partial<Record<BatchType, SimpleKey>> = {
    sampler: "samplers",
    scheduler: "schedulers",
    style: "styles",
};

interface StatusEvent {
    batchType: string | null;
    total: number;
    index?: number;
    label?: string;
    phase?: string;
}

interface Summary {
    batchType: string | null;
    total: number;
    completed: number;
    failed: number;
    aborted: boolean;
    skipped: { key: string; args: unknown[] } | null;
    warnings: Array<{ key: string; args: unknown[] }>;
}

/** Grouped checkbox list — the model / prompt / workflow cases. */
function GroupList({
    groupSet,
    onPick,
    emptyText,
}: {
    groupSet: ReturnType<typeof B.createGroupSet>;
    onPick: (group: string, member: string | null, checked: boolean) => void;
    emptyText: string;
}): ReactElement {
    const names = Object.keys(groupSet.defs).sort();
    if (!names.length) return <p className="nu-muted">{emptyText}</p>;
    return (
        <div className="nu-stack">
            {names.map((name) => {
                const members = groupSet.defs[name] ?? [];
                const head = B.groupCheckState(groupSet, name, members);
                return (
                    <div key={name} className="nu-group">
                        <div className="nu-row">
                            <MdCheckbox
                                checked={head.checked}
                                indeterminate={head.indeterminate}
                                aria-label={name}
                                onChange={(e) =>
                                    onPick(name, null, (e.target as unknown as { checked: boolean }).checked)
                                }
                            />
                            <b>{name}</b>
                            <span className="nu-muted">{head.count}/{head.total}</span>
                        </div>
                        {members.map((member) => (
                            <label key={member} className="nu-row nu-row--indent">
                                <MdCheckbox
                                    checked={B.isMemberSelected(groupSet, name, member)}
                                    aria-label={member}
                                    onChange={(e) =>
                                        onPick(name, member, (e.target as unknown as { checked: boolean }).checked)
                                    }
                                />
                                <span className="nu-ellip">{member}</span>
                            </label>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

/** Checkpoint picker: the folder tree core builds over the real checkpoint universe. */
function CheckpointTree({ state }: { state: ReturnType<typeof B.createBatchState> }): ReactElement {
    const ckpt = state.checkpoints;
    // buildFolderTree returns a Map<folder, models[]> with "" (root) sorted first.
    const folders = [...B.buildFolderTree(ckpt.all) as Map<string, string[]>].map(
        ([name, models]) => ({ name, models }),
    );
    const head = (models: string[]) => B.folderCheckState(state, models);
    const asProps = (v: string) => ({ checked: v === "checked", indeterminate: v === "indeterminate" });
    return (
        <div className="nu-stack">
            <div className="nu-row">
                <MdTextButton onClick={() => { B.setAllCheckpoints(ckpt, "all"); touchBatch(); }}>
                    {tr("nu.batch.all", "Select all")}
                </MdTextButton>
                <MdTextButton onClick={() => { B.setAllCheckpoints(ckpt, "none"); touchBatch(); }}>
                    {tr("nu.batch.none", "None")}
                </MdTextButton>
                <span className="nu-muted">
                    {ckpt.mode} · {ckpt.selected.size}/{ckpt.all.length}
                </span>
            </div>
            {folders.map((folder) => (
                <div key={folder.name || "."} className="nu-group">
                    <div className="nu-row">
                        <MdCheckbox
                            {...asProps(head(folder.models))}
                            aria-label={folder.name || "root"}
                            onChange={(e) => {
                                B.toggleCheckpointFolder(ckpt, folder.models, (e.target as unknown as { checked: boolean }).checked);
                                touchBatch();
                            }}
                        />
                        <b>{folder.name || "."}</b>
                    </div>
                    {folder.models.map((model) => (
                        <label key={model} className="nu-row nu-row--indent">
                            <MdCheckbox
                                checked={ckpt.mode === "all" || ckpt.selected.has(model)}
                                aria-label={model}
                                onChange={(e) => {
                                    B.toggleCheckpointModel(ckpt, model, (e.target as unknown as { checked: boolean }).checked);
                                    touchBatch();
                                }}
                            />
                            <span className="nu-ellip">{model}</span>
                        </label>
                    ))}
                </div>
            ))}
        </div>
    );
}

export function BatchPanel({
    workflow,
    filename,
    seedMode,
    seedValue,
    styleCatalog,
    onItemDone,
    onPickType,
}: {
    workflow: object | null;
    filename: string;
    seedMode: "random" | "fixed";
    seedValue: number;
    styleCatalog: Array<{ name: string }>;
    onItemDone?: () => void;
    onPickType?: (type: BatchType) => void;
}): ReactElement {
    const snackbar = useSnackbar();
    const state = getState().batch;
    const [, bump] = useState(0);
    const [active, setActive] = useState<BatchType>("lora");
    const [running, setRunning] = useState(false);
    const [paused, setPaused] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
    const [log, setLog] = useState<Array<{ label: string; ok: boolean; detail: string }>>([]);
    const abortRef = useRef<AbortController | null>(null);
    const rerender = useCallback(() => bump((n) => n + 1), []);

    const loadUniverse = useCallback(
        async (type: BatchType): Promise<void> => {
            try {
                if (type === "lora" || type === "checkpoint") {
                    await B.loadBatchGroups(state, [type]);
                }
                if (type === "checkpoint") {
                    const models = await comfyUI.fetchCheckpoints();
                    B.setCheckpointUniverse(state, Array.isArray(models) ? models : []);
                }
                if (type === "prompt") {
                    const rows = (await api.listPrompts()) as unknown;
                    await B.loadPromptGroups(state, Array.isArray(rows) ? rows : []);
                }
                if (type === "workflow") {
                    const rows = (await api.listWorkflows()) as Array<{ filename: string }>;
                    B.setWorkflowGroups(state, { All: (rows ?? []).map((w) => w.filename) });
                }
                const simple = SIMPLE_KEY[type];
                if (simple) {
                    const items =
                        type === "sampler" ? await comfyUI.fetchSamplers()
                        : type === "scheduler" ? await comfyUI.fetchSchedulers()
                        : styleCatalog.map((s) => s.name);
                    B.setSimpleItems(state, simple, Array.isArray(items) ? items : []);
                }
            } catch (err) {
                snackbar.show({ label: (err as Error).message, tone: "error" });
            }
            B.setActiveBatchType(state, type);
            touchBatch();
            rerender();
        },
        [state, snackbar, rerender, styleCatalog],
    );

    useEffect(() => {
        void loadUniverse(active);
        onPickType?.(active);
    }, [active, loadUniverse, onPickType]);

    const planned = B.collectBatchItems(state, { styles: styleCatalog });

    const run = async (): Promise<void> => {
        setRunning(true);
        setLog([]);
        setProgress({ done: 0, total: planned.items.length, label: "" });
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const summary = (await B.runBatchGenerate(state, {
                workflow: workflow ?? undefined,
                filename,
                seedMode,
                seedValue,
                styles: styleCatalog,
                signal: controller.signal,
                onStatus: (event: StatusEvent) => {
                    setProgress({
                        done: (event.index ?? 0) + (event.phase === "done" ? 1 : 0),
                        total: event.total,
                        label: event.label ?? "",
                    });
                    touchBatch();
                    rerender();
                },
                onItemResult: (item: unknown, result: object) => {
                    const label = B.collectBatchItems(state, { styles: styleCatalog }).labelOf(item);
                    setLog((prev) => [...prev, { label, ok: true, detail: `${(result as { images?: unknown[] })?.images?.length ?? 0} images` }]);
                    onItemDone?.();
                },
                onItemError: (item: unknown, err: Error) => {
                    const label = B.collectBatchItems(state, { styles: styleCatalog }).labelOf(item);
                    setLog((prev) => [...prev, { label, ok: false, detail: err.message }]);
                },
            })) as Summary;
            snackbar.show({
                label: summary.skipped
                    ? `${tr("nu.batch.skipped", "Batch skipped")}: ${summary.skipped.key}`
                    : `${tr("nu.batch.finished", "Batch done")}: ${summary.completed} ok / ${summary.failed} failed${summary.aborted ? " / aborted" : ""}`,
                tone: summary.failed || summary.aborted ? "error" : "neutral",
                duration: "long",
            });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setRunning(false);
            setPaused(false);
            abortRef.current = null;
            rerender();
        }
    };

    const pick = (group: string, member: string | null, checked: boolean): void => {
        const set = B.groupSetOf(state, active);
        if (member === null) B.selectGroup(set, group, checked);
        else B.toggleGroupMember(set, group, member, checked);
        touchBatch();
        rerender();
    };

    const renderBody = (): ReactElement => {
        if (active === "checkpoint") return <CheckpointTree state={state} />;
        if (active === "lora") {
            const set = B.groupSetOf(state, "lora");
            return <GroupList groupSet={set} onPick={pick} emptyText={tr("nu.batch.noGroups", "No LoRA groups. Create them in Models.")} />;
        }
        if (active === "prompt") {
            return <GroupList groupSet={state.promptGroups} onPick={pick} emptyText={tr("nu.batch.noPrompts", "No prompt groups.")} />;
        }
        if (active === "workflow") {
            return <GroupList groupSet={state.workflowGroups} onPick={pick} emptyText={tr("nu.batch.noWorkflows", "No workflows.")} />;
        }
        const key = SIMPLE_KEY[active];
        if (!key) return <p className="nu-muted">—</p>;
        const bucket = state[key];
        return (
            <div className="nu-stack">
                <div className="nu-row">
                    <MdTextButton onClick={() => { B.setAllSimpleItems(state, key, true); touchBatch(); rerender(); }}>
                        {tr("nu.batch.all", "Select all")}
                    </MdTextButton>
                    <MdTextButton onClick={() => { B.setAllSimpleItems(state, key, false); touchBatch(); rerender(); }}>
                        {tr("nu.batch.none", "None")}
                    </MdTextButton>
                    <span className="nu-muted">{bucket.selected.size}/{bucket.items.length}</span>
                </div>
                {bucket.items.map((item: string) => (
                    <label key={item} className="nu-row">
                        <MdCheckbox
                            checked={bucket.selected.has(item)}
                            aria-label={item}
                            onChange={(e) => {
                                B.toggleSimpleItem(state, key, item, (e.target as unknown as { checked: boolean }).checked);
                                touchBatch();
                                rerender();
                            }}
                        />
                        <span className="nu-ellip">{item}</span>
                    </label>
                ))}
            </div>
        );
    };

    return (
        <section className="nu-panel">
            <div className="nu-card__head">
                <h2 className="nu-card__title">{tr("nu.batch.title", "Batch")}</h2>
                <span className="nu-muted">{planned.items.length} {tr("nu.batch.selected", "selected")}</span>
                <span className="nu-spacer" />
                {running ? (
                    <>
                        <MdOutlinedButton
                            onClick={() => {
                                if (paused) { B.resumeBatch(state); setPaused(false); }
                                else { B.pauseBatch(state); setPaused(true); }
                                rerender();
                            }}
                        >
                            {paused ? tr("nu.batch.resume", "resume") : tr("nu.batch.pause", "pause")}
                        </MdOutlinedButton>
                        <MdFilledButton onClick={() => { B.abortBatch(state); abortRef.current?.abort(); }}>
                            {tr("nu.batch.stop", "Stop")}
                        </MdFilledButton>
                    </>
                ) : (
                    <MdFilledButton disabled={!planned.items.length || !workflow} onClick={() => void run()}>
                        <MdIcon slot="icon">playlist_play</MdIcon>
                        {tr("nu.batch.run", "Run batch")}
                    </MdFilledButton>
                )}
            </div>
            {running && progress.total > 0 ? <MdLinearProgress value={progress.done / progress.total} aria-label={tr("nu.batch.progress", "Batch progress")} /> : null}
            {progress.label && running ? <p className="nu-muted">{progress.label}</p> : null}
            <MdDivider />
            <div className="nu-row nu-row--wrap" role="group" aria-label={tr("nu.batch.dimension", "Batch dimension")}>
                {TYPES.map((t) => {
                    const isActive = active === t;
                    const Label = isActive ? MdFilledButton : MdOutlinedButton;
                    return (
                        <Label key={t} onClick={() => setActive(t)} aria-pressed={isActive}>
                            {B.BATCH_TYPE_LABELS[t] ?? t}
                        </Label>
                    );
                })}
            </div>
            {renderBody()}
            {log.length ? (
                <ul className="nu-log">
                    {log.map((entry, i) => (
                        <li key={`${entry.label}-${i}`} className={entry.ok ? "nu-log__ok" : "nu-log__fail"}>
                            <MdIcon aria-hidden="true">{entry.ok ? "check" : "error"}</MdIcon>
                            <span className="nu-ellip">{entry.label}</span>
                            <span className="nu-muted">{entry.detail}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
