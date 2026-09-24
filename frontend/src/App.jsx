import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { MdIconButton, MdIcon, MdLinearProgress } from "./md.js";
import { useHashRoute, VIEWS } from "./useHashRoute.js";
import { SnackbarProvider, useSnackbar } from "./snackbar.jsx";
import { comfyUI, getSettings, initI18n, readPref, settings, tr } from "core";

/**
 * Views are code-split: the heaviest ones (models, gallery) only download when
 * they are opened, which keeps first paint on a remote ComfyUI box fast.
 */
const VIEWS_MODULES = {
    workflow: lazy(() => import("./views/Workflow.jsx")),
    generate: lazy(() => import("./views/Generate.jsx")),
    models: lazy(() => import("./views/Models.jsx")),
    prompt: lazy(() => import("./views/Prompt.jsx")),
    gallery: lazy(() => import("./views/Gallery.jsx")),
    settings: lazy(() => import("./views/Settings.jsx")),
};

const THEME_POLL_MS = 15000;

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "m3-light" ? "m3-light" : "m3-dark";
    return document.documentElement.dataset.theme;
}

function ConnectionDot({ connected }) {
    if (connected === null) return null;
    return (
        <span className="nu-top-bar__status">
            <span
                className={
                    "nu-top-bar__dot " + (connected ? "nu-top-bar__dot--on" : "nu-top-bar__dot--off")
                }
                aria-hidden="true"
            />
            {connected ? tr("nu.status.online", "connected") : tr("nu.status.offline", "disconnected")}
        </span>
    );
}

function Shell() {
    const { view, params, navigate } = useHashRoute();
    const snackbar = useSnackbar();
    const [theme, setTheme] = useState(() => applyTheme(readPref("theme", "m3-dark")));
    const [connected, setConnected] = useState(null);
    const active = VIEWS.find((v) => v.id === view) || VIEWS[0];
    const View = VIEWS_MODULES[active.id];

    /*
     * ComfyUI reachability. `comfyUI.updateUrl()` is what every core network
     * call depends on, so it runs before anything else can reach the server.
     */
    useEffect(() => {
        let cancelled = false;
        const probe = async () => {
            const ok = await comfyUI.checkConnection();
            if (!cancelled) setConnected(ok);
        };
        probe();
        const timer = setInterval(probe, THEME_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    const toggleTheme = useCallback(() => {
        setTheme((prev) => {
            const next = prev === "m3-light" ? "m3-dark" : "m3-light";
            settings.writePref("theme", next);
            return applyTheme(next);
        });
    }, []);

    useEffect(() => {
        if (connected === false) {
            snackbar.show({
                label: tr("nu.warn.comfyOffline", "ComfyUI is unreachable — check its address in Settings."),
                tone: "error",
                duration: "long",
                actionLabel: tr("nu.warn.openSettings", "Open Settings"),
                onAction: () => navigate("settings"),
            });
        }
        // Deliberately keyed on the boolean transition, not on every probe.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected === false]);

    return (
        <div className="nu-app">
            <header className="nu-top-bar">
                <span className="nu-top-bar__title">{tr(active.labelKey, active.label)}</span>
                <ConnectionDot connected={connected} />
                <MdIconButton
                    ariaLabel={tr("nu.action.toggleTheme", "Toggle colour scheme")}
                    title={tr("nu.action.toggleTheme", "Toggle colour scheme")}
                    onClick={toggleTheme}
                >
                    <MdIcon>{theme === "m3-light" ? "dark_mode" : "light_mode"}</MdIcon>
                </MdIconButton>
                <MdIconButton
                    ariaLabel={tr("nu.action.openOldUi", "Open the previous interface")}
                    title={tr("nu.action.openOldUi", "Open the previous interface")}
                    onClick={() => window.open("/wfm", "_blank", "noopener")}
                >
                    <MdIcon>open_in_new</MdIcon>
                </MdIconButton>
            </header>

            <nav className="nu-rail" aria-label={tr("nu.nav.label", "Views")}>
                {VIEWS.map((item) => {
                    const ItemView = VIEWS_MODULES[item.id];
                    void ItemView;
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
                <Suspense fallback={<MdLinearProgress indeterminate />}>
                    <View
                        params={params}
                        navigate={navigate}
                        connected={connected}
                        onConnectedChange={setConnected}
                    />
                </Suspense>
            </main>
        </div>
    );
}

export default function App() {
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
