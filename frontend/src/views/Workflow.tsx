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
import { confirmDialog, promptDialog } from "../dialogs.js";
import { useApp, clearWorkflowHandoff } from "../store.js";
import { api, comfyWorkflow, highlightJSON, tr } from "core";
import type { ViewProps } from "../App.js";

interface WorkflowRow {
    filename?: string;
    name?: string;
    analysis?: unknown;
    metadata?: { description?: string; tags?: string[] } | null;
    mtime?: number;
    thumbnail?: string | null;
}

const nameOf = (w: WorkflowRow): string => String(w.filename ?? w.name ?? "");

export default function Workflow({ navigate }: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [rows, setRows] = useState<WorkflowRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const [json, setJson] = useState("");
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            const data = (await api.listWorkflows()) as WorkflowRow[];
            setRows(Array.isArray(data) ? data : []);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setLoading(false);
        }
    }, [snackbar]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Gallery → Workflow: adopt the restored workflow for editing.
    const { workflowHandoff } = useApp();
    const lastHandoff = useRef<number>(0);
    useEffect(() => {
        if (!workflowHandoff || workflowHandoff.token === lastHandoff.current) return;
        lastHandoff.current = workflowHandoff.token;
        setSelected(workflowHandoff.path);
        setJson(workflowHandoff.json);
        setDirty(true);
        clearWorkflowHandoff();
    }, [workflowHandoff]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? rows.filter((r) => nameOf(r).toLowerCase().includes(q)) : rows;
    }, [rows, query]);

    const open = async (filename: string): Promise<void> => {
        try {
            const raw = await api.loadWorkflow(filename);
            setJson(JSON.stringify(raw, null, 2));
            setSelected(filename);
            setDirty(false);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const save = async (): Promise<void> => {
        if (!selected) return;
        setBusy(true);
        try {
            await api.saveWorkflow(selected, JSON.parse(json));
            snackbar.show({ label: tr("nu.workflow.saved", "Workflow saved.") });
            setDirty(false);
            await refresh();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setBusy(false);
        }
    };

    const rename = async (): Promise<void> => {
        if (!selected) return;
        const next = await promptDialog({ title: tr("nu.workflow.renamePrompt", "New name"), value: selected.replace(/\.json$/i, "") });
        if (!next) return;
        try {
            await api.renameWorkflow(selected, next);
            setSelected(null);
            setJson("");
            await refresh();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const remove = async (): Promise<void> => {
        if (!selected) return;
        if (!(await confirmDialog({ title: tr("nu.workflow.deleteConfirm", "Delete this workflow?"), danger: true, confirmLabel: tr("nu.action.delete", "Delete") }))) return;
        try {
            await api.deleteWorkflow(selected);
            setSelected(null);
            setJson("");
            await refresh();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const onFiles = async (files: FileList | null): Promise<void> => {
        if (!files?.length) return;
        try {
            await api.importWorkflows(Array.from(files));
            await refresh();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    /** Parity item 1/2 evidence: how many editable fields the graph yields. */
    const inspect = (): void => {
        if (!json) return;
        try {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            const format = comfyWorkflow.detectFormat(parsed, selected ?? undefined);
            const apiForm = format === "api" ? parsed : comfyWorkflow.convertUiToApi(parsed);
            const analysis = comfyWorkflow.analyzeWorkflow(apiForm);
            const counts = Object.entries(analysis as Record<string, unknown>)
                .filter(([, v]) => Array.isArray(v))
                .map(([k, v]) => `${k}=${(v as unknown[]).length}`)
                .join("  ");
            snackbar.show({ label: `${format}: ${counts}`, duration: "long" });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    return (
        <div className="nu-view">
            {loading ? <MdLinearProgress indeterminate /> : null}

            <div className="nu-view__toolbar">
                <MdOutlinedTextField
                    className="nu-grow"
                    label={tr("nu.workflow.search", "Search workflows")}
                    value={query}
                    onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                />
                <MdOutlinedButton onClick={() => void refresh()}>
                    <MdIcon slot="icon">refresh</MdIcon>
                    {tr("nu.action.reload", "Reload")}
                </MdOutlinedButton>
                <input ref={fileRef} type="file" accept=".json" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
                <MdOutlinedButton onClick={() => fileRef.current?.click()}>
                    <MdIcon slot="icon">upload</MdIcon>
                    {tr("nu.workflow.import", "Import")}
                </MdOutlinedButton>
                <MdFilledButton disabled={!dirty || busy} onClick={() => void save()}>
                    {tr("nu.action.save", "Save")}
                </MdFilledButton>
            </div>

            <div className="nu-split">
                <MdOutlinedCard className="nu-list-panel">
                    {filtered.length === 0 ? (
                        <p className="nu-empty">{tr("nu.workflow.none", "No workflows.")}</p>
                    ) : (
                        filtered.map((row) => {
                            const name = nameOf(row);
                            return (
                                <button
                                    key={name}
                                    type="button"
                                    className={"nu-file" + (name === selected ? " nu-file--active" : "")}
                                    onClick={() => void open(name)}
                                >
                                    <MdIcon>description</MdIcon>
                                    <span className="nu-file__name">{name}</span>
                                </button>
                            );
                        })
                    )}
                </MdOutlinedCard>

                <MdOutlinedCard>
                    <div className="nu-card__head">
                        <h2 className="nu-card__title">{selected ?? tr("nu.workflow.editor", "Workflow JSON")}</h2>
                        <span className="nu-spacer" />
                        <MdOutlinedButton disabled={!selected} onClick={inspect}>
                            {tr("nu.workflow.inspect", "Inspect fields")}
                        </MdOutlinedButton>
                        <MdOutlinedButton disabled={!selected} onClick={() => selected && navigate("generate", { workflow: selected })}>
                            {tr("nu.workflow.run", "Open in Generate")}
                        </MdOutlinedButton>
                        <MdOutlinedButton disabled={!selected} onClick={() => void rename()}>
                            {tr("nu.action.rename", "Rename")}
                        </MdOutlinedButton>
                        <MdOutlinedButton disabled={!selected} onClick={() => void remove()}>
                            {tr("nu.action.delete", "Delete")}
                        </MdOutlinedButton>
                    </div>
                    <MdDivider />
                    <textarea
                        className="nu-code"
                        spellCheck={false}
                        value={json}
                        onInput={(e) => {
                            setJson((e.target as HTMLTextAreaElement).value);
                            setDirty(true);
                        }}
                    />
                    {json ? (
                        <pre
                            className="nu-code-preview"
                            // highlightJSON() is a pure string -> HTML producer from core/json.js.
                            dangerouslySetInnerHTML={{ __html: highlightJSON(json) }}
                        />
                    ) : null}
                </MdOutlinedCard>
            </div>
        </div>
    );
}
