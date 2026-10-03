import { useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { MdCheckbox, MdDialog, MdFilledButton, MdOutlinedButton, MdTextButton } from "./md.js";
import { useSnackbar } from "./snackbar.js";
import { models as M, tr } from "core";

type DialogElement = HTMLElement & {
    show: () => void;
    close: (returnValue?: string) => void;
};

interface Props {
    /** Model names of the type currently listed — upstream plans over the current view. */
    names: string[];
    metadata: Record<string, unknown>;
    cache: Record<string, unknown>;
    palette: Record<string, string>;
    /** Called with the palette the plan wrote, so the caller can re-read metadata. */
    onApplied: (palette: Record<string, string>) => void;
}

/** Shapes returned by `core/models.js`; the core layer is plain JS, so they are declared here. */
type Assignment = { model: string; label: string };
type Plan = {
    assignments: Assignment[];
    labels: Map<string, { colour: string; count: number }>;
    noInfo: number;
};

/**
 * "Auto badges from CivitAI" (upstream v0.7.9): derive one badge per model from the cached
 * CivitAI `baseModel`, preview the collapse, then append it. The rule table, the plan, the
 * palette merge and the 8-parallel writes all live in `core/models.js`, so both UIs agree.
 *
 * Labels come from upstream's own i18n keys (`autoBadge*`) rather than new `nu.*` ones, which is
 * what keeps them translated in all three languages for free.
 */
export default function AutoBadges({ names, metadata, cache, palette, onApplied }: Props): ReactElement {
    const snackbar = useSnackbar();
    const dialogRef = useRef<DialogElement | null>(null);
    // Upstream's dialog ships both boxes with overwrite ON and skip OFF.
    const [overwrite, setOverwrite] = useState(true);
    const [skipExisting, setSkipExisting] = useState(false);
    const [busy, setBusy] = useState(false);

    const plan = useMemo(() => M.planAutoBadges(names, metadata, cache) as Plan, [names, metadata, cache]);
    const targets = useMemo(
        () => M.autoBadgeTargets(plan, metadata, { skipExisting }) as Assignment[],
        [plan, metadata, skipExisting],
    );
    const rows = useMemo(() => {
        const used = new Set(targets.map((t) => t.label));
        return [...plan.labels.entries()]
            .filter(([label]) => used.has(label))
            .sort((a, b) => b[1].count - a[1].count);
    }, [plan, targets]);

    const open = (): void => {
        if (plan.assignments.length === 0) {
            snackbar.show({ label: tr("autoBadgeNoData", "No CivitAI base model info found. Fetch CivitAI info first.") });
            return;
        }
        dialogRef.current?.show();
    };

    const apply = async (): Promise<void> => {
        setBusy(true);
        try {
            const next = M.mergeAutoBadgePalette(palette, { ...plan, assignments: targets }, { overwrite });
            M.saveBadgePalette(next);
            const written = await M.assignAutoBadges(plan, metadata, { skipExisting });
            onApplied(next);
            snackbar.show({
                label: `${written} ${tr("autoBadgeDone", "badges applied")} · ${tr("autoBadgeTitle", "Auto badges")}`,
            });
        } catch (err) {
            snackbar.show({ label: (err as Error).message, tone: "error" });
        } finally {
            setBusy(false);
            dialogRef.current?.close("applied");
        }
    };

    return (
        <>
            <MdOutlinedButton onClick={open}>
                {tr("autoBadgeTitle", "Auto badges")}
            </MdOutlinedButton>
            <MdDialog ref={(el) => { dialogRef.current = el as DialogElement | null; }}>
                <div slot="headline">{tr("autoBadgeTitle", "Auto badges from CivitAI")}</div>
                <div slot="content" className="nu-dialog__body nu-stack">
                    <p className="nu-muted">{tr("autoBadgeDesc", "Create badges from CivitAI base model info of the current tab's models. Existing badges on models are kept; badges are added.")}</p>
                    {rows.map(([label, info]) => (
                        <div className="nu-row" key={label}>
                            <span className="nu-badge" style={{ "--badge-color": info.colour } as CSSProperties}>{label}</span>
                            <span>{info.count}</span>
                            <span className="nu-muted">
                                {label in palette ? tr("autoBadgeExisting", "existing (color overwritten)") : tr("autoBadgeNew", "new")}
                            </span>
                        </div>
                    ))}
                    <p className="nu-muted">
                        {tr("autoBadgeNoInfo", "Models without base model info (skipped)")}: {plan.noInfo}
                    </p>
                    <div className="nu-row">
                        <MdCheckbox
                            checked={overwrite}
                            aria-label={tr("autoBadgeOverwrite", "Overwrite colors of existing badges with the same name")}
                            onChange={() => setOverwrite((v) => !v)}
                        />
                        <span className="nu-muted">{tr("autoBadgeOverwrite", "Overwrite colors of existing badges with the same name")}</span>
                    </div>
                    <div className="nu-row">
                        <MdCheckbox
                            checked={skipExisting}
                            aria-label={tr("autoBadgeSkipExisting", "Skip models that already have any badge")}
                            onChange={() => setSkipExisting((v) => !v)}
                        />
                        <span className="nu-muted">{tr("autoBadgeSkipExisting", "Skip models that already have any badge")}</span>
                    </div>
                </div>
                <div slot="actions" className="nu-dialog__actions">
                    <MdTextButton onClick={() => dialogRef.current?.close("cancel")}>
                        {tr("nu.action.cancel", "Cancel")}
                    </MdTextButton>
                    <MdFilledButton disabled={busy || targets.length === 0} onClick={() => void apply()}>
                        {`${tr("autoBadgeApply", "Apply")} (${targets.length})`}
                    </MdFilledButton>
                </div>
            </MdDialog>
        </>
    );
}
