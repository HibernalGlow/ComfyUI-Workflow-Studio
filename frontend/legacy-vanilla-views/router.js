/**
 * router.js — hash router for the six frozen views (brief §5).
 *
 * Routes: `#/workflow` `#/generate` `#/models` `#/prompt` `#/gallery` `#/settings`.
 * Empty or unknown hashes fall back to `workflow`, so a stale bookmark can never
 * land on a blank screen, and Back/Forward keep working through `hashchange`.
 *
 * Store shape (this router writes the first two; main.js owns the rest):
 *     view      : string   active view id, one of the six above
 *     viewTitle : string   label for the top app bar
 *     connected : boolean  ComfyUI reachable — written by main.js
 *     theme     : string   "m3-dark" | "m3-light" — written by main.js
 *
 * `ctx` is assembled by main.js; every view receives `{ ...ctx, router, navigate,
 * params }`:
 *     ctx.items     [{ id, label }] the nav table — drives validation + titles
 *     ctx.store     store instance (title / rail active item updates)
 *     ctx.snackbar  snackbar namespace, passed through
 *     ctx.dialog    dialog namespace, passed through
 *     ctx.setTheme  (theme) => theme, the Settings view hook, passed through
 *
 * Views are pulled in with dynamic `import()`, so a view that fails to load (or
 * throws while rendering) can only break its own pane: the shell stays up and
 * shows a `.nu-error` panel with a retry button.
 */
import { escapeHtml, t } from "../core/index.js";

const DEFAULT_VIEW = "workflow";

/** Views whose module is not `views/<id>.js`. */
const MODULE_PATH = { models: "./views/models/index.js" };

/** Upstream `t()` returns the key itself when the dictionary lacks it. */
function tr(key, fallback) {
    const value = t(key);
    return value && value !== key ? value : fallback;
}

const moduleUrl = (id) => new URL(MODULE_PATH[id] || `./views/${id}.js`, import.meta.url).href;

/**
 * @param {{ root: HTMLElement, ctx?: object }} options
 * @returns {{ start(): Promise, navigate(id: string, params?: object): any,
 *             current(): string|null, onChange(cb: Function): Function, destroy(): void }}
 */
export function createRouter({ root, ctx = {} } = {}) {
    if (!root) throw new Error("createRouter: a root element is required");

    const items = Array.isArray(ctx.items) && ctx.items.length
        ? ctx.items
        : [{ id: DEFAULT_VIEW, label: "Workflow" }];
    const byId = new Map(items.map((item) => [item.id, item]));
    const fallbackId = byId.has(DEFAULT_VIEW) ? DEFAULT_VIEW : items[0].id;

    const listeners = new Set();
    let currentId = null;
    let currentParams = {};
    let viewHandle = null;
    let token = 0; // drops a render that a newer navigation superseded
    let started = false;
    let destroyed = false;

    const titleOf = (id) => byId.get(id)?.label || id;

    function parseHash() {
        const id = (window.location.hash || "").replace(/^#\/?/, "").trim();
        return byId.has(id) ? id : fallbackId;
    }

    /** Store + local listeners: the rail and the top app bar follow the store. */
    function publish(id, params) {
        ctx.store?.setState({ view: id, viewTitle: titleOf(id) });
        for (const listener of Array.from(listeners)) {
            try {
                listener(id, params);
            } catch (err) {
                console.error("[newui] router listener threw", err);
            }
        }
    }

    function teardown() {
        try {
            viewHandle?.destroy?.();
        } catch (err) {
            console.error("[newui] view destroy() threw", err);
        }
        viewHandle = null;
        root.replaceChildren(); // also detaches every listener the view owned
    }

    function renderError(container, id, error) {
        const panel = document.createElement("div");
        panel.className = "nu-error";
        panel.setAttribute("role", "alert");
        panel.innerHTML = `<p>${escapeHtml(tr("loadError", "Load error"))} — ${escapeHtml(id)}</p>`
            + `<p class="nu-muted">${escapeHtml(error?.message || String(error))}</p>`;

        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "m3-btn m3-btn--outlined";
        retry.textContent = tr("refresh", "Retry");
        retry.addEventListener("click", () => {
            load(id, currentParams);
        });
        panel.appendChild(retry);
        container.replaceChildren(panel);
    }

    async function load(id, params) {
        const run = ++token;
        teardown();
        currentId = id;
        currentParams = params || {};
        publish(id, currentParams);

        const container = document.createElement("div"); // the view's root element
        root.appendChild(container);

        try {
            const mod = await import(moduleUrl(id));
            if (destroyed || run !== token) return null;
            const renderView = mod.render || mod.default;
            if (typeof renderView !== "function") throw new Error(`view "${id}" exports no render()`);
            const handle = await renderView(container, { ...ctx, router: api, navigate, params: currentParams });
            if (destroyed || run !== token) {
                handle?.destroy?.();
                return null;
            }
            viewHandle = handle || null;
            return viewHandle;
        } catch (err) {
            if (destroyed || run !== token) return null;
            console.error(`[newui] view "${id}" failed`, err);
            viewHandle = null;
            renderError(container, id, err);
            return null;
        }
    }

    function onHashChange() {
        const id = parseHash();
        if (id !== currentId) load(id, {});
    }

    function start() {
        if (started || destroyed) return undefined;
        started = true;
        window.addEventListener("hashchange", onHashChange);
        // The initial hash is normalised rather than rewritten: `/…/newui.html`
        // stays clean until the user actually navigates.
        return load(parseHash(), {});
    }

    function navigate(id, params) {
        const target = byId.has(id) ? id : fallbackId;
        const hash = `#/${target}`;
        if (window.location.hash !== hash) {
            window.location.hash = hash; // hashchange performs the render
            return undefined;
        }
        if (target === currentId && !params) return viewHandle; // already there
        return load(target, params || {});
    }

    function current() {
        return currentId;
    }

    function onChange(listener) {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        listeners.clear();
        window.removeEventListener("hashchange", onHashChange);
        teardown();
    }

    const api = { start, navigate, current, onChange, destroy };
    return api;
}
