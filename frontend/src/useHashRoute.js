import { useCallback, useEffect, useState } from "react";

/** The 6 navigation destinations — brief §5. Nothing else appears in newui. */
export const VIEWS = [
    { id: "workflow", labelKey: "tabWorkflow", label: "Workflow", icon: "account_tree" },
    { id: "generate", labelKey: "tabGenerate", label: "Generate", icon: "auto_awesome" },
    { id: "models", labelKey: "tabModels", label: "Models", icon: "inventory_2" },
    { id: "prompt", labelKey: "tabPrompt", label: "Prompt", icon: "edit_note" },
    { id: "gallery", labelKey: "tabGallery", label: "Gallery", icon: "photo_library" },
    { id: "settings", labelKey: "tabSettings", label: "Settings", icon: "settings" },
];

export const DEFAULT_VIEW = "workflow";

const VALID = new Set(VIEWS.map((v) => v.id));

function readHash() {
    const raw = String(window.location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return VALID.has(raw) ? raw : DEFAULT_VIEW;
}

/** Hash routing: #/generate, #/models, … ; unknown ids fall back to the default. */
export function useHashRoute() {
    const [view, setView] = useState(readHash);
    const [params, setParams] = useState(() => new URLSearchParams());

    useEffect(() => {
        const sync = () => {
            setView(readHash());
            const q = String(window.location.hash || "").split("?")[1] || "";
            setParams(new URLSearchParams(q));
        };
        sync();
        window.addEventListener("hashchange", sync);
        return () => window.removeEventListener("hashchange", sync);
    }, []);

    const navigate = useCallback((id, query) => {
        if (!VALID.has(id)) return;
        const qs = query ? "?" + new URLSearchParams(query).toString() : "";
        const next = `#/${id}${qs}`;
        if (window.location.hash === next) setView(id);
        else window.location.hash = next;
    }, []);

    return { view, params, navigate, views: VIEWS };
}
