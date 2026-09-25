/**
 * Generation presets (brief §6 row 7) — list the server's presets, save the sampler settings as
 * a new one, apply one to the workflow that is currently loaded, and delete one.
 *
 * The payload is built by `core/presets.js`, not here: the shape has to match what
 * `py/services/gen_presets_service.py` reads back, and that contract is asserted in the unit
 * tests rather than guessed at the call site. `storyLoras` is a prop because the only mount so
 * far (Settings) has no story context and therefore stores sampler settings only; mounting the
 * card where the story chips live is what feeds `loras`, matching the old UI's widget in the
 * Generate tab.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
    MdDialog,
    MdDivider,
    MdFilledButton,
    MdOutlinedButton,
    MdOutlinedCard,
    MdLinearProgress,
    MdOutlinedTextField,
    MdIcon,
} from "./md.js";
import { confirmDialog } from "./dialogs.js";
import { useSnackbar } from "./snackbar.js";
import { getClientGraph, setClientGraph } from "./coreBridge.js";
import { api, comfyWorkflow, lora as loraCore, presets as presetCore, tr } from "core";

type Dict = Record<string, unknown>;

interface FormState {
    name: string;
    description: string;
    sampling_mode: "single" | "double";
    steps: string;
    cfg: string;
    sampler_name: string;
    scheduler: string;
    denoise: string;
    stage1steps: string;
    stage1cfg: string;
    stage1sampler_name: string;
    stage1scheduler: string;
    stage2steps: string;
    stage2cfg: string;
    stage2sampler_name: string;
    stage2scheduler: string;
}

const EMPTY_FORM: FormState = {
    name: "",
    description: "",
    sampling_mode: "single",
    steps: "12",
    cfg: "1.6",
    sampler_name: "euler_ancestral",
    scheduler: "beta57",
    denoise: "1.0",
    stage1steps: "5",
    stage1cfg: "4.6",
    stage1sampler_name: "er_sde",
    stage1scheduler: "simple",
    stage2steps: "12",
    stage2cfg: "1.6",
    stage2sampler_name: "dpmpp_2m_sde_gpu",
    stage2scheduler: "beta57",
};

/** Sampler fields a preset writes, read back off the graph for the "what changed" report. */
const FIELDS = ["steps", "cfg", "sampler_name", "scheduler", "denoise"] as const;

/** A linked input prints as the wire, not as `String(["929",3])` — otherwise the readout loses
 *  the one detail that matters: applying a preset overwrites the wire with a literal. */
function fieldValue(value: unknown): string {
    return Array.isArray(value) ? `link(${String(value[0])}:${String(value[1])})` : String(value);
}

function samplerSnapshot(workflow: Dict | null): string {
    if (!workflow) return "—";
    const found: string[] = [];
    for (const node of Object.values(workflow) as Dict[]) {
        const inputs = (node?.inputs ?? {}) as Dict;
        for (const field of FIELDS) {
            if (inputs[field] !== undefined) found.push(`${field}=${fieldValue(inputs[field])}`);
        }
    }
    return found.length ? found.slice(0, 6).join(" ") : "—";
}

export function GenPresetsCard({ storyLoras = null }: { storyLoras?: Dict[] | null }): ReactElement | null {
    const snackbar = useSnackbar();
    const [presets, setPresets] = useState<Dict[]>([]);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [busy, setBusy] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);

    const load = useCallback(async (): Promise<void> => {
        setStatus("loading");
        try {
            const list = await api.listGenPresets();
            setPresets(Array.isArray(list) ? (list as Dict[]) : []);
            setStatus("ready");
        } catch {
            setPresets([]);
            setStatus("error");
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const set = (key: keyof FormState) => (value: string) =>
        setForm((f) => ({ ...f, [key]: value }));

    const field = (key: keyof FormState, label: string, type: "text" | "number" = "text", step?: string) => (
        <MdOutlinedTextField
            label={label}
            value={form[key]}
            type={type}
            step={step}
            onInput={(e) => set(key)((e.target as HTMLInputElement).value)}
        />
    );

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

    const save = async (): Promise<void> => {
        const name = form.name.trim();
        if (!name) {
            snackbar.show({ label: tr("nu.presets.needName", "Give the preset a name first"), tone: "error" });
            return;
        }
        setSaving(true);
        try {
            const record = presetCore.buildSamplerPreset(form, {
                loras: loraCore.activeLoras(storyLoras),
            });
            await api.saveGenPreset(record);
            setForm(EMPTY_FORM);
            await load();
            snackbar.show({ label: tr("nu.presets.saved", "Preset saved") + ": " + name });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setSaving(false);
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

    // Upstream keeps the whole bar visible when there is nothing to pick (`fetchGenPresets`
    // swallows the error and the select simply shows its placeholder), and its "save current"
    // button is always there. Hiding the card on an empty or failed list would take the entry
    // point away precisely when the user needs it, so the card renders in every state.
    const lorasToStore = loraCore.activeLoras(storyLoras);

    return (
        <MdOutlinedCard>
            <div className="nu-card__head">
                <h2 className="nu-card__title">{tr("nu.settings.presets", "Generation presets")}</h2>
                {status === "ready" ? <span className="nu-muted">{presets.length}</span> : null}
                <MdFilledButton onClick={() => setSaving(true)}>
                    <MdIcon slot="icon">save</MdIcon>
                    {tr("nu.presets.saveCurrent", "Save current setup")}
                </MdFilledButton>
            </div>
            <MdDivider />
            <div className="nu-card__body">
                {status === "loading" ? (
                    <MdLinearProgress indeterminate aria-label={tr("nu.common.loading", "Loading")} />
                ) : null}
                {status === "error" ? (
                    <div className="nu-row">
                        <span className="nu-muted">
                            {tr("nu.presets.loadFailed", "The preset list could not be read from this server.")}
                        </span>
                        <MdOutlinedButton onClick={() => void load()}>
                            <MdIcon slot="icon">refresh</MdIcon>
                            {tr("nu.action.retry", "Retry")}
                        </MdOutlinedButton>
                    </div>
                ) : null}
                {status === "ready" && presets.length === 0 ? (
                    <p className="nu-muted">
                        {tr("nu.presets.noneYet", "No presets stored yet. Save the current sampler settings to create one.")}
                    </p>
                ) : null}
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

            <MdDialog
                open={saving}
                aria-label={tr("nu.presets.saveTitle", "Save as a preset")}
                onCancel={() => setSaving(false)}
                onClose={() => setSaving(false)}
            >
                <div slot="headline">{tr("nu.presets.saveTitle", "Save as a preset")}</div>
                <div className="nu-stack">
                    {field("name", tr("nu.presets.presetName", "Preset name"))}
                    {field("description", tr("nu.presets.description", "Description"))}
                    {/* A native select, like the Generate view's workflow picker: the @lit/react
                        wrapper for md-outlined-select does not expose a typed change event. */}
                    <select
                        className="nu-native-select"
                        aria-label={tr("nu.presets.mode", "Sampling mode")}
                        value={form.sampling_mode}
                        onChange={(e) => set("sampling_mode")(e.target.value === "double" ? "double" : "single")}
                    >
                        <option value="single">{tr("nu.presets.single", "Single-pass")}</option>
                        <option value="double">{tr("nu.presets.double", "Two-stage")}</option>
                    </select>
                    {form.sampling_mode === "single" ? (
                        <div className="nu-fields">
                            {field("steps", tr("nu.presets.steps", "Steps"), "number")}
                            {field("cfg", "CFG", "number", "0.1")}
                            {field("sampler_name", tr("nu.presets.sampler", "Sampler"))}
                            {field("scheduler", tr("nu.presets.scheduler", "Scheduler"))}
                            {field("denoise", tr("nu.presets.denoise", "Denoise"), "number", "0.05")}
                        </div>
                    ) : (
                        <>
                            <div className="nu-fields">
                                {field("stage1steps", tr("nu.presets.s1steps", "Stage 1 steps"), "number")}
                                {field("stage1cfg", tr("nu.presets.s1cfg", "Stage 1 CFG"), "number", "0.1")}
                                {field("stage1sampler_name", tr("nu.presets.s1sampler", "Stage 1 sampler"))}
                                {field("stage1scheduler", tr("nu.presets.s1scheduler", "Stage 1 scheduler"))}
                            </div>
                            <div className="nu-fields">
                                {field("stage2steps", tr("nu.presets.s2steps", "Stage 2 steps"), "number")}
                                {field("stage2cfg", tr("nu.presets.s2cfg", "Stage 2 CFG"), "number", "0.1")}
                                {field("stage2sampler_name", tr("nu.presets.s2sampler", "Stage 2 sampler"))}
                                {field("stage2scheduler", tr("nu.presets.s2scheduler", "Stage 2 scheduler"))}
                            </div>
                        </>
                    )}
                    <p className="nu-muted">
                        {lorasToStore.length
                            ? `${tr("nu.presets.withLoras", "Includes the active LoRAs")}: `
                                + lorasToStore.map((l: Dict) => String(l.name ?? "")).filter(Boolean).join(", ")
                            : tr("nu.presets.noLoras", "No active LoRAs, so this preset stores sampler settings only.")}
                    </p>
                </div>
                <div slot="action">
                    <MdOutlinedButton slot="action" onClick={() => setSaving(false)}>
                        {tr("nu.action.cancel", "Cancel")}
                    </MdOutlinedButton>
                    <MdFilledButton slot="action" disabled={busy !== null} onClick={() => void save()}>
                        {tr("nu.presets.confirmSave", "Save preset")}
                    </MdFilledButton>
                </div>
            </MdDialog>
        </MdOutlinedCard>
    );
}
