import { lazy, Suspense, useCallback, useEffect, useState, type ReactElement } from "react";
import { MdIcon, MdLinearProgress } from "./md.js";
import { useHashRoute, VIEWS, VIEW_GROUPS, FIRST_VIEW, type ViewDef, type ViewId } from "./useHashRoute.js";
import { SnackbarProvider, useSnackbar } from "./snackbar.js";
import { comfyUI, initI18n, readPref, setVramToastSink, writePref, tr } from "core";

/**
 * Views are code-split so that opening the page on a remote ComfyUI box does not
 * download the models and gallery bundles first.
 */
const VIEW_MODULES: Record<ViewId, React.LazyExoticComponent<(p: ViewProps) => ReactElement>> = {
    // Extensionless: Vite maps .js -> .ts/.tsx but not .jsx -> .tsx.
    workflow: lazy(() => import("./views/Workflow")),
    generate: lazy(() => import("./views/Generate")),
    models: lazy(() => import("./views/Models")),
    artists: lazy(() => import("./views/Artists")),
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

function BrandMark(): ReactElement {
    return (
        <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true" focusable="false">
            <g fill="currentColor">
                <rect x="2" y="3" width="24" height="15" rx="7.5" />
                <rect x="14" y="20" width="24" height="15" rx="7.5" opacity=".62" />
                <circle cx="33" cy="9" r="4.5" opacity=".38" />
            </g>
        </svg>
    );
}

function ConnectionDot({ connected }: { connected: boolean | null }): ReactElement | null {
    if (connected === null) return null;
    return (
        <span className={"nu-status" + (connected ? " nu-status--on" : " nu-status--off")}>
            <span className="nu-status__dot" aria-hidden="true" />
            <span className="nu-status__text">
                {connected
                    ? tr("nu.status.online", "connected")
                    : tr("nu.status.offline", "disconnected")}
            </span>
        </span>
    );
}

/**
 * The Expressive tone of a cluster of destinations. Colour here is not
 * decoration: it is the same signal in the hero, the selected rail item and the
 * tone-coded tiles, so a glance at the accent says which cluster you are in.
 */
const TONE_BY_GROUP: Record<ViewDef["group"], string> = {
    create: "primary",
    library: "sky",
    system: "spring",
};

const GROUP_LABEL: Record<ViewDef["group"], { key: string; fallback: string }> = {
    create: { key: "nu.group.create", fallback: "Create" },
    library: { key: "nu.group.library", fallback: "Library" },
    system: { key: "nu.group.system", fallback: "Studio" },
};

/** The shaped plate that gives each view its one piece of art. */
function HeroArt({ view, index }: { view: ViewDef; index: number }): ReactElement {
    return (
        <div className="nu-hero__art" aria-hidden="true">
            <svg className="nu-hero__route" viewBox="0 0 420 300" fill="none">
                <path
                    d="M22 64H120c26 0 40 13 40 39v61c0 29 15 43 44 43h150"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="2 9"
                    strokeLinecap="round"
                />
                <path
                    d="M26 244h72c24 0 36-12 36-36v-73c0-27 14-40 41-40h70"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="2 9"
                    strokeLinecap="round"
                />
                <circle cx="22" cy="64" r="4.5" fill="currentColor" />
                <circle cx="354" cy="207" r="4.5" fill="currentColor" />
                <circle cx="245" cy="95" r="4.5" fill="currentColor" />
            </svg>

            <span className="nu-hero__pill nu-hero__pill--a">
                {tr(GROUP_LABEL[view.group].key, GROUP_LABEL[view.group].fallback)}
            </span>
            <span className="nu-hero__pill nu-hero__pill--b">
                {String(index + 1).padStart(2, "0")} / {String(VIEWS.length).padStart(2, "0")}
            </span>

            <span className="nu-hero__bloom">
                <svg viewBox="0 0 240 240" focusable="false">
                    <g fill="currentColor">
                        <circle cx="120" cy="120" r="54" />
                        <circle cx="120" cy="66" r="34" />
                        <circle cx="120" cy="174" r="34" />
                        <circle cx="66" cy="120" r="34" />
                        <circle cx="174" cy="120" r="34" />
                        <circle cx="82" cy="82" r="26" />
                        <circle cx="158" cy="82" r="26" />
                        <circle cx="82" cy="158" r="26" />
                        <circle cx="158" cy="158" r="26" />
                    </g>
                </svg>
                <MdIcon>{view.icon}</MdIcon>
            </span>

            <i className="nu-hero__spark nu-hero__spark--a" />
            <i className="nu-hero__spark nu-hero__spark--b" />
        </div>
    );
}

function Shell(): ReactElement {
    const { view, params, navigate } = useHashRoute();
    const snackbar = useSnackbar();
    const [theme, setTheme] = useState<string>(() => applyTheme(readPref("theme", "m3-dark")));
    const [connected, setConnected] = useState<boolean | null>(null);

    const active: ViewDef = VIEWS.find((v) => v.id === view) ?? FIRST_VIEW;
    const activeIndex = Math.max(0, VIEWS.findIndex((v) => v.id === active.id));
    const groupLabel = GROUP_LABEL[active.group];
    const [visitedViews, setVisitedViews] = useState<Set<ViewId>>(() => new Set([active.id]));

    /*
     * Upstream v0.7.13's pre-generation VRAM unload reports through an injected sink
     * (static/js/vram-prepare.js). Registering it here is what keeps the old UI's app.js out of
     * this bundle: without a sink the unload still runs, it just stays quiet.
     */
    useEffect(() => {
        setVramToastSink((message: string, tone?: string) =>
            snackbar.show({ label: String(message), tone: tone === "error" ? "error" : "neutral" }));
        return () => setVramToastSink(null);
    }, [snackbar]);

    useEffect(() => {
        setVisitedViews((prev) => {
            if (prev.has(active.id)) return prev;
            const next = new Set(prev);
            next.add(active.id);
            return next;
        });
    }, [active.id]);

    /*
     * Reachability probe. This also flips the status pill below, and the 15 s
     * interval is what notices ComfyUI going away while the page stays open.
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

    const light = theme === "m3-light";

    return (
        <div className={"nu-app nu-tone--" + TONE_BY_GROUP[active.group]} data-view={active.id}>
            <a className="nu-skip" href="#nu-view-root">
                {tr("nu.action.skipToContent", "Skip to content")}
            </a>

            <header className="nu-top-bar">
                <button type="button" className="nu-brand" onClick={() => navigate(FIRST_VIEW.id)}>
                    <span className="nu-brand__mark">
                        <BrandMark />
                    </span>
                    <span className="nu-brand__text">
                        <span className="nu-brand__name">{tr("nu.app.title", "Workflow Studio")}</span>
                        <span className="nu-brand__caption">{tr("nu.app.tagline", "ComfyUI workspace")}</span>
                    </span>
                </button>

                <span className="nu-spacer" />
                <ConnectionDot connected={connected} />

                <button
                    type="button"
                    className="nu-control"
                    aria-label={tr("nu.action.toggleTheme", "Toggle colour scheme")}
                    title={tr("nu.action.toggleTheme", "Toggle colour scheme")}
                    onClick={toggleTheme}
                >
                    <MdIcon>{light ? "dark_mode" : "light_mode"}</MdIcon>
                    <span>{light ? tr("nu.theme.dark", "Dark") : tr("nu.theme.light", "Light")}</span>
                </button>
                <button
                    type="button"
                    className="nu-control nu-control--quiet"
                    aria-label={tr("nu.action.openOldUi", "Open the previous interface")}
                    title={tr("nu.action.openOldUi", "Open the previous interface")}
                    onClick={() => window.open("/wfm", "_blank", "noopener")}
                >
                    <MdIcon>open_in_new</MdIcon>
                    <span>{tr("nu.action.classicUi", "Classic UI")}</span>
                </button>
            </header>

            <nav className="nu-rail" aria-label={tr("nu.nav.label", "Views")}>
                {VIEW_GROUPS.map((group, groupIndex) => {
                    const items = VIEWS.filter((v) => v.group === group.id);
                    if (!items.length) return null;
                    return (
                        <div className="nu-rail__group" key={group.id}>
                            {items.map((item) => {
                                const isActive = item.id === active.id;
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={"nu-rail__item" + (isActive ? " nu-rail__item--active" : "")}
                                        aria-current={isActive ? "page" : undefined}
                                        aria-label={tr(item.labelKey, item.label)}
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
                            {groupIndex < VIEW_GROUPS.length - 1 ? (
                                <span className="nu-rail__sep" aria-hidden="true" />
                            ) : null}
                        </div>
                    );
                })}
            </nav>

            <main className="nu-main" id="nu-view-root">
                <section className="nu-hero" aria-live="polite">
                    <div className="nu-hero__copy">
                        <span className="nu-eyebrow">
                            <span className="nu-eyebrow__dot" aria-hidden="true" />
                            {tr(groupLabel.key, groupLabel.fallback)}
                            <span className="nu-eyebrow__rule" aria-hidden="true" />
                            {String(activeIndex + 1).padStart(2, "0")}
                        </span>
                        <h1 className="nu-hero__title" key={active.id}>
                            {tr(active.labelKey, active.label)}
                            <span className="nu-hero__period" aria-hidden="true">.</span>
                        </h1>
                        <p className="nu-hero__lede">{tr(active.blurbKey, active.blurb)}</p>
                    </div>
                    <HeroArt view={active} index={activeIndex} />
                </section>

                {Array.from(visitedViews).map((id) => {
                    const ViewComponent = VIEW_MODULES[id];
                    const isCurrent = id === active.id;
                    return (
                        <div key={id} style={{ display: isCurrent ? "contents" : "none" }}>
                            <Suspense fallback={isCurrent ? <MdLinearProgress indeterminate aria-label={tr("nu.common.loading", "Loading")} /> : null}>
                                <ViewComponent
                                    params={params}
                                    navigate={navigate}
                                    connected={connected}
                                    setConnected={setConnected}
                                />
                            </Suspense>
                        </div>
                    );
                })}
            </main>

            <nav className="nu-dock" aria-label={tr("nu.nav.label", "Views")}>
                {VIEWS.map((item) => {
                    const isActive = item.id === active.id;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            className={"nu-dock__item" + (isActive ? " nu-dock__item--active" : "")}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => navigate(item.id)}
                        >
                            <MdIcon>{item.icon}</MdIcon>
                            <span>{tr(item.labelKey, item.label)}</span>
                        </button>
                    );
                })}
            </nav>
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
