import { lazy, Suspense, useCallback, useEffect, useState, type ReactElement } from "react";
import { MdIconButton, MdIcon, MdLinearProgress } from "./md.js";
import { useHashRoute, VIEWS, FIRST_VIEW, type ViewDef, type ViewId } from "./useHashRoute.js";
import { SnackbarProvider, useSnackbar } from "./snackbar.js";
import { comfyUI, initI18n, readPref, writePref, tr } from "core";

/**
 * Views are code-split so that opening the page on a remote ComfyUI box does not
 * download the models and gallery bundles first.
 */
const VIEW_MODULES: Record<ViewId, React.LazyExoticComponent<(p: ViewProps) => ReactElement>> = {
    // Extensionless: Vite maps .js -> .ts/.tsx but not .jsx -> .tsx.
    workflow: lazy(() => import("./views/Workflow")),
    generate: lazy(() => import("./views/Generate")),
    models: lazy(() => import("./views/Models")),
    prompt: lazy(() => import("./views/Prompt")),
    gallery: lazy(() => import("./views/Gallery")),
    settings: lazy(() => import("./views/Settings")),
};

export interface ViewProps {
    params: URLSearchParams;
    navigate: (id: ViewId, query?: Record<string, string>) => void;
    connected: boolean | null;
    setConnected: (v: boolean) => void;
}

/** Re-applies the stored scheme and returns the value actually in the DOM. */
function applyTheme(theme: string): string {
    document.documentElement.dataset.theme = theme === "m3-light" ? "m3-light" : "m3-dark";
    return document.documentElement.dataset.theme;
}

function ConnectionDot({ connected }: { connected: boolean | null }): ReactElement | null {
    if (connected === null) return null;
    return (
        <span className="nu-top-bar__status">
            <span
                className={
                    "nu-top-bar__dot " + (connected ? "nu-top-bar__dot--on" : "nu-top-bar__dot--off")
                }
                aria-hidden="true"
            />
            {connected
                ? tr("nu.status.online", "connected")
                : tr("nu.status.offline", "disconnected")}
        </span>
    );
}

function Shell(): ReactElement {
    const { view, params, navigate } = useHashRoute();
    const snackbar = useSnackbar();
    const [theme, setTheme] = useState<string>(() => applyTheme(readPref("theme", "m3-dark")));
    const [connected, setConnected] = useState<boolean | null>(null);

    const active: ViewDef = VIEWS.find((v) => v.id === view) ?? FIRST_VIEW;
    const View = VIEW_MODULES[active.id];

    /*
     * Reachability probe. This also flips the offline warning below, and the
     * 15 s interval is what notices ComfyUI going away while the page stays open.
     */
    useEffect(() => {
        let cancelled = false;
        const probe = async (): Promise<void> => {
            const ok = await comfyUI.checkConnection();
            if (!cancelled) setConnected(ok);
        };
        void probe();
        const timer = setInterval(() => void probe(), 15000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    const toggleTheme = useCallback((): void => {
        setTheme((prev) => {
            const next = prev === "m3-light" ? "m3-dark" : "m3-light";
            writePref("theme", next);
            return applyTheme(next);
        });
    }, []);

    const wentOffline = connected === false;
    useEffect(() => {
        if (!wentOffline) return;
        snackbar.show({
            label: tr("nu.warn.comfyOffline", "ComfyUI is unreachable — check its address in Settings."),
            tone: "error",
            duration: "long",
            actionLabel: tr("nu.warn.openSettings", "Open Settings"),
            onAction: () => navigate("settings"),
        });
    }, [wentOffline, snackbar, navigate]);

    return (
        <div className="nu-app">
            <header className="nu-top-bar">
                <h1 className="nu-top-bar__title">{tr(active.labelKey, active.label)}</h1>
                <ConnectionDot connected={connected} />
                <MdIconButton
                    aria-label={tr("nu.action.toggleTheme", "Toggle colour scheme")}
                    title={tr("nu.action.toggleTheme", "Toggle colour scheme")}
                    onClick={toggleTheme}
                >
                    <MdIcon>{theme === "m3-light" ? "dark_mode" : "light_mode"}</MdIcon>
                </MdIconButton>
                <MdIconButton
                    aria-label={tr("nu.action.openOldUi", "Open the previous interface")}
                    title={tr("nu.action.openOldUi", "Open the previous interface")}
                    onClick={() => window.open("/wfm", "_blank", "noopener")}
                >
                    <MdIcon>open_in_new</MdIcon>
                </MdIconButton>
            </header>

            <nav className="nu-rail" aria-label={tr("nu.nav.label", "Views")}>
                {VIEWS.map((item) => {
                    const isActive = item.id === active.id;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            className={"nu-rail__item" + (isActive ? " nu-rail__item--active" : "")}
                            aria-current={isActive ? "page" : undefined}
                            title={tr(item.labelKey, item.label)}
                            onClick={() => navigate(item.id)}
                        >
                            <span className="nu-rail__icon">
                                <MdIcon>{item.icon}</MdIcon>
                            </span>
                            <span className="nu-rail__label">{tr(item.labelKey, item.label)}</span>
                        </button>
                    );
                })}
            </nav>

            <main className="nu-main" id="nu-view-root">
                <Suspense fallback={<MdLinearProgress indeterminate aria-label={tr("nu.common.loading", "Loading")} />}>
                    <View
                        params={params}
                        navigate={navigate}
                        connected={connected}
                        setConnected={setConnected}
                    />
                </Suspense>
            </main>
        </div>
    );
}

export default function App(): ReactElement {
    useEffect(() => {
        initI18n();
        document.title = tr("nu.app.title", "Workflow Studio");
    }, []);

    return (
        <SnackbarProvider>
            <Shell />
        </SnackbarProvider>
    );
}
