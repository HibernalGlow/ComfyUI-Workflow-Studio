/**
 * main.js — mount entry for the new M3 shell at `/wfm_static/newui.html`.
 *
 * It does five things and nothing else (views own their own panes):
 *   1. boot: settings -> `comfyUI.updateUrl()` -> `initI18n()`   (brief §1.2)
 *   2. own the store: `{ view, viewTitle, connected, theme }`
 *   3. build the nav rail (the six items of brief §5) + the top app bar slots
 *   4. poll ComfyUI reachability into the top app bar `.nu-badge`
 *   5. hand the router its ctx and start it
 *
 * No element id is queried except the sanctioned `#nu-view-root` mount point.
 */
import {
    comfyUI,
    getLang,
    getSettings,
    initI18n,
    readPref,
    t,
    writePref,
} from "../core/index.js";
import { createStore } from "./store.js";
import { createRouter } from "./router.js";
import { initRipple } from "./ripple.js";
import { createNavigationRail } from "./components/NavigationRail.js";
import * as dialog from "./dialog.js";
import * as snackbar from "./snackbar.js";

/* --------------------------------------------------------------------- boot */
// Mandatory order: without updateUrl() the shell would talk to the wrong host.
const boot = getSettings();
comfyUI.updateUrl(boot.comfyuiUrl || window.location.origin);
initI18n();
document.documentElement.lang = getLang();

/** Upstream `t()` returns the key itself when the dictionary lacks it, so this
 *  wrapper gives the frozen `t("key", "Fallback text")` shape its fallback. */
function tr(key, fallback) {
    const value = t(key);
    return value && value !== key ? value : fallback;
}

/* ------------------------------------------------------------------ nav table */
// Brief §5: exactly these six items — the old UI's other tabs must not appear.
// `icon` is a plain text glyph on purpose: the old UI ships no icon font (see
// static/css/main.css) and newui must not invent icon art, so each item uses its
// initial; "A" for Gallery is the one way to keep it distinct from Generate's "G".
const NAV_ITEMS = [
    { id: "workflow", label: tr("tabWorkflow", "Workflow"), icon: "W" },
    { id: "generate", label: tr("tabGenerate", "GenerateUI"), icon: "G" },
    { id: "models", label: tr("tabModels", "Models"), icon: "M" },
    { id: "prompt", label: tr("tabPrompt", "Prompt"), icon: "P" },
    { id: "gallery", label: tr("tabGallery", "Gallery"), icon: "A" },
    { id: "settings", label: tr("tabSettings", "Settings"), icon: "S" },
];

/* ---------------------------------------------------------------------- theme */
const APP_NAME = "Workflow Studio";
const THEMES = ["m3-dark", "m3-light"];

/** `theme-m3.css` keys off `data-theme`; the inline <head> script set it pre-paint. */
function applyTheme(theme) {
    const next = THEMES.includes(theme) ? theme : THEMES[0];
    document.documentElement.dataset.theme = next;
    return next;
}

/** Settings-view hook: persist the choice, then swap the single attribute. */
function setTheme(theme) {
    const next = applyTheme(theme);
    writePref("theme", next); // `nu_theme`, re-read by the head bootstrap
    store.setState({ theme: next });
    return next;
}

/* ------------------------------------------------------------------- the store */
const store = createStore({
    view: NAV_ITEMS[0].id,
    viewTitle: NAV_ITEMS[0].label,
    connected: null,
    theme: applyTheme(readPref("theme", THEMES[0])),
});

/* ------------------------------------------------------------- shell chrome */
const titleEl = document.querySelector(".m3-top-app-bar__title");
const trailingEl = document.querySelector(".m3-top-app-bar__trailing");
const railHost = document.querySelector(".m3-navigation-rail");

const badgeEl = document.createElement("span");
badgeEl.className = "nu-badge";
badgeEl.setAttribute("role", "status"); // polite live region — never a popup/toast
badgeEl.textContent = "offline";
trailingEl.appendChild(badgeEl);

function setConnected(connected) {
    store.setState({ connected });
    badgeEl.textContent = connected ? "online" : "offline";
    // Frozen `.nu-badge--error` (m3-layout.css) marks the unreachable state;
    // the text alone carries the meaning, so the colour is decoration only.
    badgeEl.classList.toggle("nu-badge--error", !connected);
}

async function refreshConnection() {
    try {
        setConnected(Boolean(await comfyUI.checkConnection()));
    } catch (err) {
        console.error("[newui] connection check failed", err);
        setConnected(false);
    }
}

/* --------------------------------------------------------------------- router */
let router = null; // declared first so the rail's onChange can call into it

const rail = createNavigationRail({
    items: NAV_ITEMS,
    activeId: store.getState().view,
    ariaLabel: "Main navigation",
    onChange: (id) => router.navigate(id),
});

if (rail.root instanceof Element && rail.root.classList.contains("m3-navigation-rail")) {
    // The component's own <nav> *is* the rail: swap it in for the frozen shell
    // element so `nav.m3-navigation-rail` in m3-layout.css keeps matching.
    railHost.replaceWith(rail.root);
} else {
    railHost.replaceChildren(rail.root);
}

/** Keeps the app bar title and the rail's active item on the store's `view`. */
function syncChrome(state) {
    titleEl.textContent = state.viewTitle;
    document.title = `${state.viewTitle} · ${APP_NAME}`;
    rail.setActive?.(state.view);
}

syncChrome(store.getState()); // `select` never fires at subscribe time, so paint once
// `view` and `viewTitle` are published together, so one selection covers both —
// connection polls and theme flips then leave the app bar alone.
store.select((state) => state.view, () => syncChrome(store.getState()));

const viewRoot = document.getElementById("nu-view-root");
router = createRouter({
    root: viewRoot,
    ctx: { store, items: NAV_ITEMS, snackbar, dialog, setTheme },
});

// A route change is a fresh pane: never inherit the previous scroll offset.
router.onChange(() => {
    viewRoot.scrollTop = 0;
});

/* ----------------------------------------------------------------------- run */
initRipple(document.body); // once for the whole shell; views inherit via delegation
router.start();

const CONNECTION_POLL_MS = 15000;
refreshConnection();
const connectionTimer = setInterval(refreshConnection, CONNECTION_POLL_MS);
window.addEventListener("pagehide", () => clearInterval(connectionTimer), { once: true });
