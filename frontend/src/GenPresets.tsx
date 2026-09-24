/**
 * Generation presets (brief §6 row 7) — list the server's presets, apply one to the workflow
 * that is currently loaded, and delete one.
 *
 * Deliberately absent: "save the current sampler settings as a preset". The server accepts at
 * least three shapes (`sampler_settings`, the two-stage `sampler_stage1`/`sampler_stage2` pair,
 * plus LoRA mixtures — py/services/gen_presets_service.py), and picking one from the front end
 * would write a half-formed record into the user's preset store. The API layer already exposes
 * `saveGenPreset` verbatim for whenever that schema decision is made.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { MdDivider, MdFilledButton, MdOutlinedButton, MdOutlinedCard, MdIcon } from "./md.js";
import { confirmDialog } from "./dialogs.js";
import { useSnackbar } from "./snackbar.js";
import { getClientGraph, setClientGraph } from "./coreBridge.js";
import { api, comfyWorkflow, tr } from "core";

type Dict = Record<string, unknown>;

/** Sampler fields a preset writes, read back off the graph for the "what changed" report. */
const FIELDS = ["steps", "cfg", "sampler_name", "scheduler", "denoise"] as const;

function samplerSnapshot(workflow: Dict | null): string {
    if (!workflow) return "—";
    const found: string[] = [];
    for (const node of Object.values(workflow) as Dict[]) {
        const inputs = (node?.inputs ?? {}) as Dict;
        for (const field of FIELDS) {
            if (inputs[field] !== undefined) found.push(`${field}=${String(inputs[field])}`);
        }
    }
    return found.length ? found.slice(0, 6).join(" ") : "—";
}

export function GenPresetsCard(): ReactElement | null {
    const snackbar = useSnackbar();
    const [presets, setPresets] = useState<Dict[]>([]);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        try {
            const list = await api.listGenPresets();
            setPresets(Array.isArray(list) ? (list as Dict[]) : []);
        } catch {
            setPresets([]);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const apply = async (preset: Dict): Promise<void> => {
        const id = String(preset?.id ?? "");
        const workflow = getClientGraph().workflow;
        if (!workflow) {
            snackbar.show({ label: tr("nu.presets.needWorkflow", "Load a workflow first"), tone: "error" });
            return;
        }
        setBusy(id);
        const before = samplerSnapshot(workflow);
        try {
            const res = (await api.applyGenPreset({ workflow, preset_id: id })) as { workflow?: Dict };
            if (!res?.workflow) throw new Error(tr("nu.presets.noResult", "the server returned no workflow"));
            // Re-analyse: the graph the rest of the app reads has just changed underneath it.
            setClientGraph(res.workflow as Record<string, Dict>, comfyWorkflow.analyzeWorkflow(res.workflow) as never);
            snackbar.show({
                label: `${String(preset?.name ?? id)}: ${before} → ${samplerSnapshot(res.workflow)}`,
            });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setBusy(null);
        }
    };

    const remove = async (preset: Dict): Promise<void> => {
        const id = String(preset?.id ?? "");
        if (!(await confirmDialog({
            title: tr("nu.presets.deleteConfirm", "Delete this generation preset?"),
            body: String(preset?.name ?? id),
            danger: true,
            confirmLabel: tr("nu.action.delete", "Delete"),
        }))) return;
        setBusy(id);
        try {
            await api.deleteGenPreset(id);
            await load();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setBusy(null);
        }
    };

    if (presets.length === 0) return null;

    return (
        <MdOutlinedCard>
            <div className="nu-card__head">
                <h2 className="nu-card__title">{tr("nu.settings.presets", "Generation presets")}</h2>
                <span className="nu-muted">{presets.length}</span>
            </div>
            <MdDivider />
            <div className="nu-card__body">
                {presets.map((preset) => {
                    const id = String(preset?.id ?? "");
                    const description = String(preset?.description ?? "");
                    return (
                        <div className="nu-row" key={id || String(preset?.name)}>
                            <div className="nu-presets__meta">
                                <strong>{String(preset?.name ?? id)}</strong>
                                {description ? <span className="nu-muted">{description}</span> : null}
                            </div>
                            <MdFilledButton disabled={busy === id} onClick={() => void apply(preset)}>
                                <MdIcon slot="icon">tune</MdIcon>
                                {tr("nu.presets.apply", "Apply to loaded workflow")}
                            </MdFilledButton>
                            <MdOutlinedButton disabled={busy === id} onClick={() => void remove(preset)}>
                                <MdIcon slot="icon">delete</MdIcon>
                                {tr("nu.action.delete", "Delete")}
                            </MdOutlinedButton>
                        </div>
                    );
                })}
            </div>
        </MdOutlinedCard>
    );
}
