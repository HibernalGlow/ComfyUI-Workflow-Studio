import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactElement,
    type ReactNode,
} from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdOutlinedTextField,
    MdOutlinedCard,
    MdIcon,
    MdLinearProgress,
    MdSwitch,
    MdDivider,
} from "../md.js";
import { useSnackbar } from "../snackbar.js";
import { GenPresetsCard } from "../GenPresets.js";
import {
    api,
    comfyUI,
    i18n,
    getSettings,
    updateSettings,
    getLang,
    setLang,
    tr,
} from "core";
import type { ViewProps } from "../App.js";

type Dict = Record<string, unknown>;

interface DirInfo {
    current?: string;
    default?: string;
    saved?: string | null;
}

/** Fields of the server settings dict we render as toggles vs text inputs. */
const TOGGLE_HINTS = ["auto", "enabled", "enable", "use", "show", "save", "inject", "override"];

/**
 * Keys that have their own card below — the generic editor must not also write them, because the
 * plain dict POST would bypass `/settings/models-dir`'s folder validation and cache flush.
 */
const DEDICATED_KEYS = new Set(["models_dir", "windows_selector_event_loop"]);

function isToggleKey(key: string): boolean {
    return TOGGLE_HINTS.some((hint) => key.toLowerCase().includes(hint));
}

/**
 * `md-switch` has no `label` property (its own props are `selected`, `icons`,
 * `showOnlySelectedIcon`, `required`, `value`), so the visible text is a sibling
 * and the switch is named through `aria-label`.
 */
function SwitchRow({
    label,
    selected,
    onChange,
}: {
    label: string;
    selected: boolean;
    onChange: (next: boolean) => void;
}): ReactElement {
    return (
        <div className="nu-switch-row">
            <MdSwitch selected={selected} aria-label={label} onChange={(e) => onChange((e.target as unknown as { selected: boolean }).selected)} />
            <span className="nu-switch-row__label">{label}</span>
        </div>
    );
}

function SettingsCard({
    title,
    children,
    actions,
}: {
    title: string;
    children: ReactNode;
    actions?: ReactNode;
}): ReactElement {
    return (
        <MdOutlinedCard className="nu-card">
            <div className="nu-card__head" slot="head">
                <h2 className="nu-card__title">{title}</h2>
                <span className="nu-spacer" />
                {actions}
            </div>
            <div className="nu-card__body">{children}</div>
        </MdOutlinedCard>
    );
}

export default function Settings({ setConnected }: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [url, setUrl] = useState<string>(() => String(getSettings().comfyuiUrl || ""));
    const [server, setServer] = useState<Dict>({});
    const [dirty, setDirty] = useState<Dict>({});
    const [outputDir, setOutputDir] = useState<DirInfo>({});
    const [workflowsDir, setWorkflowsDir] = useState<DirInfo>({});
    const [dirDraft, setDirDraft] = useState<{ output: string; workflows: string }>({
        output: "",
        workflows: "",
    });
    const [modelsDir, setModelsDir] = useState<{ saved?: string; roots?: string[]; effective?: Record<string, string[]> }>({});
    const [modelsDirDraft, setModelsDirDraft] = useState("");
    const [lang, setLangState] = useState<string>(() => getLang());
    const fileRef = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            const [s, out, wf, md] = await Promise.all([
                api.getSettingsFromServer(),
                api.getOutputDir(),
                api.getWorkflowsDir(),
                api.getModelsDir().catch(() => ({})),
            ]);
            setServer((s && typeof s === "object" ? s : {}) as Dict);
            setDirty({});
            setOutputDir((out || {}) as DirInfo);
            setWorkflowsDir((wf || {}) as DirInfo);
            const mdInfo = (md || {}) as { saved?: string; roots?: string[]; effective?: Record<string, string[]> };
            setModelsDir(mdInfo);
            setModelsDirDraft(String(mdInfo.saved ?? ""));
            setDirDraft({
                output: String((out as DirInfo)?.current ?? ""),
                workflows: String((wf as DirInfo)?.current ?? ""),
            });
        } catch (err) {
            snackbar.show({
                label: `${tr("nu.settings.loadFailed", "Could not load settings")}: ${(err as Error).message}`,
                tone: "error",
            });
        } finally {
            setLoading(false);
        }
    }, [snackbar]);

    useEffect(() => {
        void load();
    }, [load]);

    const saveComfyUrl = async (): Promise<void> => {
        // `wfm_settings` is shared with the old UI on purpose, and updateUrl() is
        // what every core request resolves against — so this takes effect live.
        updateSettings({ comfyuiUrl: url.trim() });
        comfyUI.updateUrl(url.trim() || window.location.origin);
        const ok = await comfyUI.checkConnection();
        setConnected(ok);
        snackbar.show({
            label: ok
                ? tr("nu.settings.urlSaved", "ComfyUI address saved and reachable.")
                : tr("nu.settings.urlUnreachable", "Address saved, but ComfyUI did not answer."),
            tone: ok ? "neutral" : "error",
        });
    };

    const saveServer = async (): Promise<void> => {
        setSaving(true);
        try {
            await api.saveSettingsToServer(dirty);
            snackbar.show({ label: tr("nu.settings.saved", "Settings saved.") });
            await load();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setSaving(false);
        }
    };

    /**
     * `POST /api/wfm/settings/models-dir` validates that every root exists (400 otherwise) and
     * clears the server's model scan cache — the generic dict editor below must not write this key,
     * so it is excluded there and saved through this route only.
     */
    const saveModelsDir = async (value: string): Promise<void> => {
        setSaving(true);
        try {
            const res = await api.setModelsDir(value.trim()) as {
                saved?: string; roots?: string[]; effective?: Record<string, string[]>;
            };
            setModelsDir(res || {});
            setModelsDirDraft(String(res?.saved ?? ""));
            snackbar.show({ label: tr("modelsDirChanged", "Models folder changed. Reload the Models tab.") });
        } catch (err) {
            snackbar.show({ label: `${tr("workflowsDirError", "Folder change error")}: ${(err as Error).message}`, tone: "error" });
        } finally {
            setSaving(false);
        }
    };

    /** Upstream v0.7.11: a plain settings key, but it only takes effect at prestartup. */
    const saveSelectorLoop = async (enabled: boolean): Promise<void> => {
        setSaving(true);
        try {
            await api.saveSettingsToServer({ windows_selector_event_loop: enabled });
            snackbar.show({ label: tr("selectorLoopSaved", "Saved. Restart ComfyUI to apply.") });
            await load();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setSaving(false);
        }
    };

    const saveOutputDir = async (): Promise<void> => {
        try {
            const res = (await api.setOutputDir(dirDraft.output)) as DirInfo;
            setOutputDir(res || {});
            snackbar.show({ label: tr("nu.settings.outputSaved", "Output directory saved.") });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const saveWorkflowsDir = async (): Promise<void> => {
        try {
            const res = (await api.setWorkflowsDir(dirDraft.workflows)) as { workflows_dir?: string };
            setWorkflowsDir({ current: res?.workflows_dir ?? "" });
            snackbar.show({ label: tr("nu.settings.workflowsDirSaved", "Workflows directory saved.") });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const onImport = async (file: File | undefined): Promise<void> => {
        if (!file) return;
        try {
            if (file.name.toLowerCase().endsWith(".zip")) {
                const r = (await api.importFullBackup(file)) as Dict;
                snackbar.show({
                    label: `${tr("nu.settings.fullRestored", "Full backup restored")}: ${String(r?.extracted ?? 0)}`,
                });
            } else {
                const bundle = JSON.parse(await file.text()) as unknown;
                const r = (await api.importSettingsBundle(bundle)) as Dict;
                snackbar.show({
                    label: `${tr("nu.settings.restored", "Settings restored")}: ${String(r?.imported ?? 0)}`,
                });
            }
            await load();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    const changedKeys = Object.keys(dirty);
    // i18n.getLanguageOptions() returns a { code: label } map, not a list.
    const languageOptions: Array<{ value: string; label: string }> = Object.entries(
        (i18n.getLanguageOptions() ?? {}) as Record<string, string>,
    ).map(([value, label]) => ({ value, label }));

    return (
        <div className="nu-view">
            {loading ? <MdLinearProgress indeterminate aria-label={tr("nu.common.loading", "Loading")} /> : null}

            <SettingsCard title={tr("nu.settings.comfy", "ComfyUI connection")}>
                <div className="nu-stack">
                    <MdOutlinedTextField
                        label={tr("nu.settings.comfyUrl", "ComfyUI address")}
                        value={url}
                        onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
                        supportingText={tr(
                            "nu.settings.comfyUrlHint",
                            "Shared with the previous UI (wfm_settings). Leave empty to use this server.",
                        )}
                    />
                    <div className="nu-row">
                        <MdFilledButton onClick={() => void saveComfyUrl()}>
                            {tr("nu.action.save", "Save")}
                        </MdFilledButton>
                        <span className="nu-muted">
                            {tr("nu.settings.currentTarget", "Current target")}: {comfyUI.baseUrl || window.location.origin}
                        </span>
                    </div>
                </div>
            </SettingsCard>

            <SettingsCard title={tr("nu.settings.paths", "Directories")}>
                <div className="nu-fields">
                    <div className="nu-stack">
                        <MdOutlinedTextField
                            label={tr("nu.settings.outputDir", "Output directory")}
                            value={dirDraft.output}
                            onInput={(e) =>
                                setDirDraft((d) => ({ ...d, output: (e.target as HTMLInputElement).value }))
                            }
                            supportingText={outputDir.default ? `default: ${outputDir.default}` : undefined}
                        />
                        <MdOutlinedButton onClick={() => void saveOutputDir()}>
                            {tr("nu.action.save", "Save")}
                        </MdOutlinedButton>
                    </div>
                    <div className="nu-stack">
                        <MdOutlinedTextField
                            label={tr("nu.settings.workflowsDir", "Workflows directory")}
                            value={dirDraft.workflows}
                            onInput={(e) =>
                                setDirDraft((d) => ({ ...d, workflows: (e.target as HTMLInputElement).value }))
                            }
                            supportingText={workflowsDir.default ? `default: ${workflowsDir.default}` : undefined}
                        />
                        <MdOutlinedButton onClick={() => void saveWorkflowsDir()}>
                            {tr("nu.action.save", "Save")}
                        </MdOutlinedButton>
                    </div>
                </div>
            </SettingsCard>

            <SettingsCard
                title={tr("nu.settings.server", "Plugin settings")}
                actions={
                    changedKeys.length ? (
                        <MdFilledButton disabled={saving} onClick={() => void saveServer()}>
                            {tr("nu.settings.saveCount", "Save")} ({changedKeys.length})
                        </MdFilledButton>
                    ) : null
                }
            >
                <div className="nu-fields">
                    {Object.entries(server).map(([key, value]) => {
                        if (DEDICATED_KEYS.has(key)) return null;
                        if (value === null || value === undefined) return null;
                        if (typeof value === "boolean") {
                            return (
                                <SwitchRow
                                    key={key}
                                    label={key}
                                    selected={value}
                                    onChange={(next) => setDirty((d) => ({ ...d, [key]: next }))}
                                />
                            );
                        }
                        if (typeof value === "object") return null;
                        if (isToggleKey(key) && ["0", "1", "true", "false"].includes(String(value))) {
                            return (
                                <SwitchRow
                                    key={key}
                                    label={key}
                                    selected={String(value) === "true" || String(value) === "1"}
                                    onChange={(next) => setDirty((d) => ({ ...d, [key]: next }))}
                                />
                            );
                        }
                        return (
                            <MdOutlinedTextField
                                key={key}
                                label={key}
                                value={String(value)}
                                onInput={(e) =>
                                    setDirty((d) => ({ ...d, [key]: (e.target as HTMLInputElement).value }))
                                }
                            />
                        );
                    })}
                </div>
            </SettingsCard>

            {/* Upstream v0.7.10: extra model roots are only reachable through the validated route. */}
            <SettingsCard
                title={tr("modelsDir", "Models Folder")}
                actions={
                    modelsDirDraft.trim() !== String(modelsDir.saved ?? "") ? (
                        <MdFilledButton disabled={saving} onClick={() => void saveModelsDir(modelsDirDraft)}>
                            {tr("workflowsDirApply", "Apply")}
                        </MdFilledButton>
                    ) : null
                }
            >
                <div className="nu-fields">
                    <MdOutlinedTextField
                        label={tr("modelsDirLabel", "Additional Models Folder Path")}
                        value={modelsDirDraft}
                        onInput={(e) => setModelsDirDraft((e.target as HTMLInputElement).value)}
                    />
                    <div className="nu-row">
                        <MdOutlinedButton
                            disabled={saving || !String(modelsDir.saved ?? "").length}
                            onClick={() => void saveModelsDir("")}
                        >
                            {tr("workflowsDirDefault", "Default")}
                        </MdOutlinedButton>
                    </div>
                    <p className="nu-muted">{tr("modelsDirHint", "Models root folder (e.g. Stability Matrix's Models). Subfolders such as StableDiffusion / Lora / VAE / ControlNet / TextEncoders / DiffusionModels / Embeddings / HyperNetworks (or ComfyUI names like checkpoints / loras) are added to the Models tab. Separate multiple folders with ;. Empty to reset.")}</p>
                    {(modelsDir.roots ?? []).map((root) => (
                        <p className="nu-muted" key={root}>{root}</p>
                    ))}
                </div>
            </SettingsCard>

            {/* Upstream v0.7.11: read at prestartup, so it cannot apply without a ComfyUI restart. */}
            <SettingsCard title={tr("selectorLoop", "Windows Stability (Event Loop)")}>
                <div className="nu-fields">
                    <SwitchRow
                        label={tr("selectorLoopLabel", "Use the Selector event loop on Windows (restart required)")}
                        selected={server.windows_selector_event_loop === true || String(server.windows_selector_event_loop) === "true"}
                        onChange={(next) => void saveSelectorLoop(next)}
                    />
                    <p className="nu-muted">{tr("selectorLoopHint", "Turn this on if ComfyUI freezes (all tabs stop responding, even generation) after switching Models lists with many previews. Switches the Windows asyncio loop from Proactor to Selector. Takes effect after restarting ComfyUI; asyncio subprocess features are unavailable and the connection limit is about 512. Leave off if you have no problem.")}</p>
                </div>
            </SettingsCard>

            <SettingsCard title={tr("nu.settings.language", "Language")}>
                <div className="nu-row">
                    {languageOptions.map((opt) => (
                        <MdOutlinedButton
                            key={opt.value}
                            onClick={() => {
                                setLang(opt.value);
                                setLangState(opt.value);
                                snackbar.show({
                                    label: tr("nu.settings.langSaved", "Language changed."),
                                });
                            }}
                            aria-pressed={lang === opt.value}
                        >
                            {opt.label}
                        </MdOutlinedButton>
                    ))}
                </div>
            </SettingsCard>

            <SettingsCard title={tr("nu.settings.backup", "Backup & restore")}>
                <MdDivider />
                <div className="nu-row">
                    {/* The anchor's label lives inside a slotted custom element, so its accessible
                        name is stated explicitly instead of relying on name-from-content. */}
                    <a
                        className="nu-link"
                        href={api.settingsExportUrl()}
                        download
                        aria-label={tr("nu.settings.export", "Export settings")}
                    >
                        <MdOutlinedButton>
                            <MdIcon slot="icon">download</MdIcon>
                            {tr("nu.settings.export", "Export settings")}
                        </MdOutlinedButton>
                    </a>
                    <a
                        className="nu-link"
                        href={api.settingsExportFullUrl({ includeWorkflows: true })}
                        download
                        aria-label={tr("nu.settings.exportFull", "Full backup (zip)")}
                    >
                        <MdOutlinedButton>
                            <MdIcon slot="icon">folder_zip</MdIcon>
                            {tr("nu.settings.exportFull", "Full backup (zip)")}
                        </MdOutlinedButton>
                    </a>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".json,.zip"
                        hidden
                        onChange={(e) => void onImport(e.target.files?.[0])}
                    />
                    <MdFilledButton onClick={() => fileRef.current?.click()}>
                        <MdIcon slot="icon">upload</MdIcon>
                        {tr("nu.settings.import", "Restore from file")}
                    </MdFilledButton>
                </div>
            </SettingsCard>

            <GenPresetsCard />
        </div>
    );
}
