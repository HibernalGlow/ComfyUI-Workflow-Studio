import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
    MdFilledButton,
    MdOutlinedButton,
    MdOutlinedTextField,
    MdOutlinedCard,
    MdLinearProgress,
    MdIcon,
    MdTextButton,
} from "../md.js";
import { useSnackbar } from "../snackbar.js";
import { api, wildcard as WC, style as styleCore, tr } from "core";
import type { ViewProps } from "../App.js";

interface PromptRow {
    id?: string;
    name?: string;
    text?: string;
    content?: string;
    tags?: string[];
}

const idOf = (p: PromptRow): string => String(p.id ?? p.name ?? "");
const textOf = (p: PromptRow): string => String(p.text ?? p.content ?? "");

export default function Prompt(_props: ViewProps): ReactElement {
    const snackbar = useSnackbar();
    const [prompts, setPrompts] = useState<PromptRow[]>([]);
    const [styles, setStyles] = useState<Array<{ name: string; prompt?: string; negative_prompt?: string }>>([]);
    const [wildcards, setWildcards] = useState<Array<{ name?: string; filename?: string }>>([]);
    const [loading, setLoading] = useState(true);
    const [draft, setDraft] = useState<PromptRow>({ name: "", text: "" });
    const [expanded, setExpanded] = useState("");

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            const [p, s, w] = await Promise.all([
                api.listPrompts() as Promise<PromptRow[] | { prompts?: PromptRow[] }>,
                api.listStyles() as Promise<Array<{ name: string; prompt?: string; negative_prompt?: string }>>,
                api.getWildcards() as Promise<Array<{ name?: string; filename?: string }>>,
            ]);
            setPrompts(Array.isArray(p) ? p : ((p as { prompts?: PromptRow[] })?.prompts ?? []));
            setStyles(Array.isArray(s) ? s : []);
            setWildcards(Array.isArray(w) ? w : []);
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setLoading(false);
        }
    }, [snackbar]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const save = async (): Promise<void> => {
        try {
            if (idOf(draft)) await api.updatePrompt(idOf(draft), draft);
            else await api.createPrompt(draft);
            setDraft({ name: "", text: "" });
            await refresh();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const remove = async (id: string): Promise<void> => {
        if (!window.confirm(tr("nu.prompt.deleteConfirm", "Delete this prompt?"))) return;
        try {
            await api.deletePrompt(id);
            await refresh();
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const previewExpansion = async (): Promise<void> => {
        try {
            setExpanded(await WC.expandWildcardText(draft.text || ""));
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    const editWildcard = async (name: string): Promise<void> => {
        try {
            const data = (await api.getWildcardContent(name)) as { content?: string };
            const next = window.prompt(`${name}`, String(data?.content ?? ""));
            if (next === null) return;
            await api.saveWildcard(name, next);
            snackbar.show({ label: tr("nu.prompt.wildcardSaved", "Wildcard saved.") });
            WC.clearWildcardCache(name.replace(/\.txt$/i, ""));
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        }
    };

    return (
        <div className="nu-view">
            {loading ? <MdLinearProgress indeterminate /> : null}

            <MdOutlinedCard>
                <div className="nu-card__head">
                    <h2 className="nu-card__title">{tr("nu.prompt.editor", "Prompt")}</h2>
                    <span className="nu-spacer" />
                    <MdFilledButton onClick={() => void save()}>{idOf(draft) ? tr("nu.action.update", "Update") : tr("nu.action.create", "Create")}</MdFilledButton>
                </div>
                <div className="nu-card__body">
                    <MdOutlinedTextField
                        label="name"
                        value={String(draft.name ?? "")}
                        onInput={(e) => setDraft((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))}
                    />
                    <MdOutlinedTextField
                        label={tr("nu.prompt.body", "Text (supports __wildcard__ tokens)")}
                        value={textOf(draft)}
                        rows={6}
                        onInput={(e) => setDraft((d) => ({ ...d, text: (e.target as HTMLTextAreaElement & HTMLInputElement).value }))}
                    />
                    <div className="nu-row">
                        <MdOutlinedButton onClick={() => void previewExpansion()}>
                            <MdIcon slot="icon">auto_fix_high</MdIcon>
                            {tr("nu.prompt.preview", "Preview wildcard expansion")}
                        </MdOutlinedButton>
                        <MdTextButton onClick={() => setDraft({ name: "", text: "" })}>{tr("nu.action.reset", "Reset")}</MdTextButton>
                    </div>
                    {expanded ? <pre className="nu-pre">{expanded}</pre> : null}
                </div>
            </MdOutlinedCard>

            <MdOutlinedCard>
                <div className="nu-card__head">
                    <h2 className="nu-card__title">{tr("nu.prompt.library", "Library")} ({prompts.length})</h2>
                </div>
                <div className="nu-card__body">
                    {prompts.map((p) => (
                        <div key={idOf(p)} className="nu-list-row">
                            <span className="nu-list-row__main">
                                <b>{String(p.name ?? idOf(p))}</b>
                                <em className="nu-muted">{textOf(p).slice(0, 120)}</em>
                            </span>
                            <MdTextButton onClick={() => setDraft(p)}>{tr("nu.action.edit", "Edit")}</MdTextButton>
                            <MdTextButton onClick={() => void remove(idOf(p))}>{tr("nu.action.delete", "Delete")}</MdTextButton>
                        </div>
                    ))}
                </div>
            </MdOutlinedCard>

            <MdOutlinedCard>
                <div className="nu-card__head">
                    <h2 className="nu-card__title">{tr("nu.prompt.styles", "Styles")} ({styles.length})</h2>
                </div>
                <div className="nu-card__body">
                    {styles.map((s) => (
                        <div key={s.name} className="nu-list-row">
                            <span className="nu-list-row__main">
                                <b>{s.name}</b>
                                <em className="nu-muted">{String(s.prompt ?? "").slice(0, 120)}</em>
                            </span>
                            <MdTextButton
                                onClick={() => {
                                    void styleCore
                                        .resolveStyleByName(s.name)
                                        .then((resolved) => {
                                            const text = (resolved as { prompt?: string } | null)?.prompt;
                                            setDraft((d) => ({ ...d, text: text ? String(text) : d.text }));
                                        });
                                }}
                            >
                                → editor
                            </MdTextButton>
                        </div>
                    ))}
                </div>
            </MdOutlinedCard>

            <MdOutlinedCard>
                <div className="nu-card__head">
                    <h2 className="nu-card__title">{tr("nu.prompt.wildcards", "Wildcards")} ({wildcards.length})</h2>
                    <span className="nu-spacer" />
                    <MdOutlinedButton onClick={() => void api.createWildcardLink()}>
                        {tr("nu.prompt.link", "Link wildcard folder")}
                    </MdOutlinedButton>
                </div>
                <div className="nu-card__body">
                    {wildcards.map((w) => {
                        const name = String(w.filename ?? w.name ?? "");
                        return (
                            <div key={name} className="nu-list-row">
                                <span className="nu-list-row__main"><b>{name}</b></span>
                                <MdTextButton onClick={() => void editWildcard(name)}>{tr("nu.action.edit", "Edit")}</MdTextButton>
                            </div>
                        );
                    })}
                </div>
            </MdOutlinedCard>
        </div>
    );
}
