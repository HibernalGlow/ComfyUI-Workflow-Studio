import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdOutlinedTextField,
    MdOutlinedCard,
    MdLinearProgress,
    MdIcon,
    MdDivider,
} from "../md.js";
import { useSnackbar } from "../snackbar.js";
import { setClientGraph, getClientGraph, type ApiWorkflow, type Analysis } from "../coreBridge.js";
import {
    api,
    comfyUI,
    comfyWorkflow,
    runGeneration,
    style as styleCore,
    image as imageCore,
    tr,
} from "core";
import type { ViewProps } from "../App.js";

interface GenResult {
    src: string;
    filename: string;
    seed: number;
}

interface WorkflowNode {
    class_type?: string;
    inputs?: Record<string, unknown>;
}

/** Editable inputs = primitives that are not links (`[nodeId, slot]`) or hidden widgets. */
function editableInputs(node: WorkflowNode) {
    return Object.entries(node.inputs || {}).filter(([key, value]) => {
        if (key.startsWith("_")) return false;
        if (Array.isArray(value)) return false;
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    });
}

export default function Generate({ params }: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [workflows, setWorkflows] = useState<Array<{ filename: string }>>([]);
    const [chosen, setChosen] = useState<string>(params.get("workflow") ?? "");
    const [apiWorkflow, setApiWorkflow] = useState<ApiWorkflow | null>(null);
    const [prompt, setPrompt] = useState("");
    const [negative, setNegative] = useState("");
    const [seedMode, setSeedMode] = useState<"random" | "fixed">("random");
    const [seedValue, setSeedValue] = useState(0);
    const [styleName, setStyleName] = useState("");
    const [styles, setStyles] = useState<Array<{ name: string }>>([]);
    const [progress, setProgress] = useState<number | null>(null);
    const [results, setResults] = useState<GenResult[]>([]);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        void (async () => {
            const [list, catalog] = await Promise.all([
                api.listWorkflows() as Promise<Array<{ filename: string }>>,
                styleCore.fetchStyles(),
            ]);
            setWorkflows(Array.isArray(list) ? list : []);
            setStyles(catalog);
        })().catch((err: Error) => setError(err.message));
    }, []);

    /** Parity item 1: load JSON -> analysis -> generated parameter fields. */
    const load = useCallback(
        async (filename: string): Promise<void> => {
            if (!filename) return;
            setError(null);
            try {
                const raw = await api.loadWorkflow(filename);
                const format = comfyWorkflow.detectFormat(raw, filename);
                const apiForm = format === "api" ? raw : comfyWorkflow.convertUiToApi(raw);
                const analysis = comfyWorkflow.analyzeWorkflow(apiForm);
                setClientGraph(apiForm as ApiWorkflow, analysis as Analysis);
                setApiWorkflow(apiForm as ApiWorkflow);
                const graph = apiForm as ApiWorkflow;
                const prompts: Array<{ id: string; role: string }> =
                    (analysis as Analysis).prompt_nodes ?? [];
                const pos = prompts.find((n) => n.role === "positive");
                const neg = prompts.find((n) => n.role === "negative");
                setPrompt(pos ? String(graph[pos.id]?.inputs?.text ?? "") : "");
                setNegative(neg ? String(graph[neg.id]?.inputs?.text ?? "") : "");
            } catch (err) {
                setError((err as Error).message);
            }
        },
        [],
    );

    useEffect(() => {
        if (chosen) void load(chosen);
    }, [chosen, load]);

    const nodes = useMemo(
        () => Object.entries((apiWorkflow ?? {}) as Record<string, WorkflowNode>),
        [apiWorkflow],
    );

    const setField = (nodeId: string, key: string, value: unknown): void => {
        setApiWorkflow((prev) => {
            if (!prev) return prev;
            const next = JSON.parse(JSON.stringify(prev)) as Record<
                string,
                { inputs?: Record<string, unknown> }
            >;
            if (next[nodeId]?.inputs) next[nodeId].inputs![key] = value;
            setClientGraph(next, getClientGraph().analysis);
            return next;
        });
    };

    const run = async (): Promise<void> => {
        if (!apiWorkflow) return;
        setError(null);
        setResults([]);
        setProgress(0);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const out = await runGeneration({
                workflow: apiWorkflow,
                prompt: prompt || undefined,
                negative: negative || undefined,
                seedMode,
                seedValue,
                styleName,
                onProgress: (pct) => setProgress(pct),
                signal: controller.signal,
            });
            setApiWorkflow(out.workflow as ApiWorkflow);
            setSeedValue(Number(out.seed) || 0);
            const dir = await imageCore.fetchOutputDir().catch(() => "");
            const withSrc: GenResult[] = [];
            for (const img of out.images || []) {
                try {
                    const blob = await comfyUI.getImageBlob(img);
                    withSrc.push({
                        src: await imageCore.blobToDataUrl(blob),
                        filename: String(img.filename ?? ""),
                        seed: Number(out.seed) || 0,
                    });
                } catch {
                    /* one unreadable image must not lose the rest */
                }
            }
            setResults(withSrc);
            setProgress(null);
            void imageCore
                .saveGeneratedImagesMeta(out.images, out.workflow, { outputDir: dir })
                .catch(() => undefined);
            snackbar.show({
                label: `${tr("nu.generate.done", "Generated")} ${withSrc.length} · seed ${out.seed}`,
            });
        } catch (err) {
            setProgress(null);
            const e = err as Error;
            if (e.name === "AbortError") {
                snackbar.show({ label: tr("nu.generate.aborted", "Stopped.") });
            } else {
                setError(e.message);
            }
        } finally {
            abortRef.current = null;
        }
    };

    const stop = (): void => abortRef.current?.abort();

    return (
        <div className="nu-view">
            <div className="nu-view__toolbar">
                <MdOutlinedTextField
                    label={tr("nu.generate.workflow", "Workflow")}
                    value={chosen}
                    readOnly
                    disabled
                />
                <select
                    className="nu-native-select"
                    aria-label={tr("nu.generate.workflow", "Workflow")}
                    value={chosen}
                    onChange={(e) => setChosen(e.target.value)}
                >
                    <option value="">—</option>
                    {workflows.map((w) => (
                        <option key={w.filename} value={w.filename}>
                            {w.filename}
                        </option>
                    ))}
                </select>
                <span className="nu-spacer" />
                {progress === null ? (
                    <MdFilledButton disabled={!apiWorkflow} onClick={() => void run()}>
                        <MdIcon slot="icon">play_arrow</MdIcon>
                        {tr("nu.generate.run", "Generate")}
                    </MdFilledButton>
                ) : (
                    <MdOutlinedButton onClick={stop}>{tr("nu.generate.stop", "Stop")}</MdOutlinedButton>
                )}
            </div>

            {progress !== null ? (
                <div className="nu-stack" aria-live="polite">
                    <MdLinearProgress value={progress} />
                    <span className="nu-muted">{Math.round(progress * 100)}%</span>
                </div>
            ) : null}

            {error ? <p className="nu-error">{error}</p> : null}

            <MdOutlinedCard>
                <div className="nu-card__body">
                    <MdOutlinedTextField
                        label={tr("nu.generate.prompt", "Positive prompt")}
                        value={prompt}
                        rows={4}
                        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement & HTMLInputElement).value)}
                    />
                    <MdOutlinedTextField
                        label={tr("nu.generate.negative", "Negative prompt")}
                        value={negative}
                        rows={3}
                        onInput={(e) => setNegative((e.target as HTMLTextAreaElement & HTMLInputElement).value)}
                    />
                    <div className="nu-fields">
                        <select
                            className="nu-native-select"
                            aria-label={tr("nu.generate.seedMode", "Seed mode")}
                            value={seedMode}
                            onChange={(e) => setSeedMode(e.target.value === "fixed" ? "fixed" : "random")}
                        >
                            <option value="random">{tr("nu.generate.seedRandom", "Random seed")}</option>
                            <option value="fixed">{tr("nu.generate.seedFixed", "Fixed seed")}</option>
                        </select>
                        {seedMode === "fixed" ? (
                            <MdOutlinedTextField
                                label={tr("nu.generate.seed", "Seed")}
                                type="number"
                                value={String(seedValue)}
                                onInput={(e) => setSeedValue(Number((e.target as HTMLInputElement).value) || 0)}
                            />
                        ) : null}
                        <select
                            className="nu-native-select"
                            aria-label={tr("nu.generate.style", "Style")}
                            value={styleName}
                            onChange={(e) => setStyleName(e.target.value)}
                        >
                            <option value="">{tr("nu.generate.noStyle", "No style")}</option>
                            {styles.map((s) => (
                                <option key={s.name} value={s.name}>
                                    {s.name}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </MdOutlinedCard>

            {apiWorkflow ? (
                <MdOutlinedCard>
                    <div className="nu-card__head">
                        <h2 className="nu-card__title">{tr("nu.generate.params", "Workflow parameters")}</h2>
                        <span className="nu-muted">{nodes.length} nodes</span>
                    </div>
                    <MdDivider />
                    <div className="nu-card__body">
                        {nodes.map(([id, node]) => {
                            const fields = editableInputs(node);
                            if (!fields.length) return null;
                            return (
                                <section key={id} className="nu-node">
                                    <h3 className="nu-node__title">
                                        {node.class_type} <span className="nu-muted">#{id}</span>
                                    </h3>
                                    <div className="nu-fields">
                                        {fields.map(([key, value]) =>
                                            typeof value === "boolean" ? (
                                                <label key={key} className="nu-switch-row">
                                                    <input
                                                        type="checkbox"
                                                        checked={value}
                                                        onChange={(e) => setField(id, key, e.target.checked)}
                                                    />
                                                    <span>{key}</span>
                                                </label>
                                            ) : (
                                                <MdOutlinedTextField
                                                    key={key}
                                                    label={key}
                                                    type={typeof value === "number" ? "number" : "text"}
                                                    value={String(value)}
                                                    onInput={(e) => {
                                                        const el = e.target as HTMLInputElement;
                                                        setField(id, key, typeof value === "number" ? Number(el.value) : el.value);
                                                    }}
                                                />
                                            ),
                                        )}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                </MdOutlinedCard>
            ) : null}

            {results.length ? (
                <MdOutlinedCard>
                    <div className="nu-card__head">
                        <h2 className="nu-card__title">{tr("nu.generate.results", "Results")}</h2>
                    </div>
                    <div className="nu-grid">
                        {results.map((r, i) => (
                            <figure key={`${r.filename}-${i}`} className="nu-shot">
                                <img src={r.src} alt={r.filename} loading="lazy" />
                                <figcaption className="nu-muted">{r.filename}</figcaption>
                            </figure>
                        ))}
                    </div>
                </MdOutlinedCard>
            ) : null}
        </div>
    );
}
