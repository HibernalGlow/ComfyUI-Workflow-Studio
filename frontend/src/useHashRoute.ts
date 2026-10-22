import { useCallback, useEffect, useState } from "react";

/** The 6 navigation destinations — brief §5. Nothing else appears in newui. */
export type ViewId =
    | "workflow"
    | "generate"
    | "models"
    | "artists"
    | "prompt"
    | "gallery"
    | "settings";

export interface ViewDef {
    id: ViewId;
    labelKey: string;
    label: string;
    /** Material Symbols ligature name. */
    icon: string;
    /**
     * What the destination is for, in one line. The shell renders it under the
     * destination name in the hero, so the word "Models" is not the only thing
     * telling someone what they are looking at.
     */
    blurbKey: string;
    blurb: string;
    /** Rail group: the Expressive rail reads as three clusters, not seven tiles. */
    group: "create" | "library" | "system";
}

export const VIEW_GROUPS: readonly { id: "create" | "library" | "system"; labelKey: string; label: string }[] = [
    { id: "create", labelKey: "nu.group.create", label: "Create" },
    { id: "library", labelKey: "nu.group.library", label: "Library" },
    { id: "system", labelKey: "nu.group.system", label: "Studio" },
] as const;

export const VIEWS: readonly ViewDef[] = [
    {
        id: "workflow",
        labelKey: "tabWorkflow",
        label: "Workflow",
        icon: "account_tree",
        blurbKey: "nu.blurb.workflow",
        blurb: "Open a workflow, read its nodes, edit the parameters.",
        group: "create",
    },
    {
        id: "generate",
        labelKey: "tabGenerate",
        label: "Generate",
        icon: "auto_awesome",
        blurbKey: "nu.blurb.generate",
        blurb: "Queue a run on the compute box and follow it while it works.",
        group: "create",
    },
    {
        id: "prompt",
        labelKey: "tabPrompt",
        label: "Prompt",
        icon: "edit_note",
        blurbKey: "nu.blurb.prompt",
        blurb: "Wildcards, saved styles and the prompt text itself.",
        group: "create",
    },
    {
        id: "models",
        labelKey: "tabModels",
        label: "Models",
        icon: "inventory_2",
        blurbKey: "nu.blurb.models",
        blurb: "Checkpoints and LoRAs on disk, with tags and previews.",
        group: "library",
    },
    {
        id: "artists",
        labelKey: "tabArtists",
        label: "画师库",
        icon: "palette",
        blurbKey: "nu.blurb.artists",
        blurb: "The LoRAs trained from artist styles and their triggers.",
        group: "library",
    },
    {
        id: "gallery",
        labelKey: "tabGallery",
        label: "Gallery",
        icon: "photo_library",
        blurbKey: "nu.blurb.gallery",
        blurb: "Everything this studio has already drawn.",
        group: "library",
    },
    {
        id: "settings",
        labelKey: "tabSettings",
        label: "Settings",
        icon: "settings",
        blurbKey: "nu.blurb.settings",
        blurb: "Where ComfyUI lives, what the studio writes, how it looks.",
        group: "system",
    },
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
