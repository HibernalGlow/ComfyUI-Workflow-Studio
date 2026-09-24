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
    const [lang, setLangState] = useState<string>(() => getLang());
    const fileRef = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            const [s, out, wf] = await Promise.all([
                api.getSettingsFromServer(),
                api.getOutputDir(),
                api.getWorkflowsDir(),
            ]);
            setServer((s && typeof s === "object" ? s : {}) as Dict);
            setDirty({});
            setOutputDir((out || {}) as DirInfo);
            setWorkflowsDir((wf || {}) as DirInfo);
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
            {loading ? <MdLinearProgress indeterminate /> : null}

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
                    <a
                        className="nu-link"
                        href={api.settingsExportUrl()}
                        download
                    >
                        <MdOutlinedButton>
                            <MdIcon slot="icon">download</MdIcon>
                            {tr("nu.settings.export", "Export settings")}
                        </MdOutlinedButton>
                    </a>
                    <a className="nu-link" href={api.settingsExportFullUrl({ includeWorkflows: true })} download>
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
        </div>
    );
}
