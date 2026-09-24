import { useCallback, useEffect, useState } from "react";

/** The 6 navigation destinations — brief §5. Nothing else appears in newui. */
export type ViewId =
    | "workflow"
    | "generate"
    | "models"
    | "prompt"
    | "gallery"
    | "settings";

export interface ViewDef {
    id: ViewId;
    labelKey: string;
    label: string;
    /** Material Symbols ligature name. */
    icon: string;
}

export const VIEWS: readonly ViewDef[] = [
    { id: "workflow", labelKey: "tabWorkflow", label: "Workflow", icon: "account_tree" },
    { id: "generate", labelKey: "tabGenerate", label: "Generate", icon: "auto_awesome" },
    { id: "models", labelKey: "tabModels", label: "Models", icon: "inventory_2" },
    { id: "prompt", labelKey: "tabPrompt", label: "Prompt", icon: "edit_note" },
    { id: "gallery", labelKey: "tabGallery", label: "Gallery", icon: "photo_library" },
    { id: "settings", labelKey: "tabSettings", label: "Settings", icon: "settings" },
] as const;

export const DEFAULT_VIEW: ViewId = "workflow";

const VALID = new Set<string>(VIEWS.map((v) => v.id));

/**
 * The default view's definition, resolved once so callers never deal with an
 * `undefined` from indexing into `VIEWS`.
 */
export const FIRST_VIEW: ViewDef = VIEWS.find((v) => v.id === DEFAULT_VIEW) as ViewDef;

function readHash(): ViewId {
    const raw = String(window.location.hash || "").replace(/^#\/?/, "").split("?")[0] ?? "";
    return VALID.has(raw) ? (raw as ViewId) : DEFAULT_VIEW;
}

/** Hash routing: `#/generate`, `#/models`, … ; unknown ids fall back to the default. */
export function useHashRoute(): {
    view: ViewId;
    params: URLSearchParams;
    navigate: (id: ViewId, query?: Record<string, string>) => void;
} {
    const [view, setView] = useState<ViewId>(readHash);
    const [params, setParams] = useState<URLSearchParams>(() => new URLSearchParams());

    useEffect(() => {
        const sync = (): void => {
            setView(readHash());
            const q = String(window.location.hash || "").split("?")[1] || "";
            setParams(new URLSearchParams(q));
        };
        sync();
        window.addEventListener("hashchange", sync);
        return () => window.removeEventListener("hashchange", sync);
    }, []);

    const navigate = useCallback((id: ViewId, query?: Record<string, string>): void => {
        if (!VALID.has(id)) return;
        const qs = query ? "?" + new URLSearchParams(query).toString() : "";
        const next = `#/${id}${qs}`;
        if (window.location.hash === next) setView(id);
        else window.location.hash = next;
    }, []);

    return { view, params, navigate };
}
