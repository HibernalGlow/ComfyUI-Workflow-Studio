/**
 * tools/contrast-audit.mjs — WCAG 1.4.3 audit for the new UI, run inside the page.
 *
 * It is a browser module, not a Node script: copy it somewhere the ComfyUI static route
 * serves (the gitignored build dir works: `cp tools/contrast-audit.mjs static/newui/`) and
 * then, from the page:
 *
 *     const m = await import("/wfm_static/newui/contrast-audit.mjs");
 *     window.__AUDIT = await m.run();          // starts the sweep
 *     ... later: m.progress() / m.results()
 *
 * Three things make a naive contrast walk report failures that are not there, and this file
 * exists because all three were hit in one session (MIGRATION-NOTES §5.1):
 *   1. @material/web paints a control's container on a `.background` box inside its own
 *      shadow root, as a *sibling* of the label — so the colour behind the text is never an
 *      ancestor's background. We descend into shadow roots and composite whatever covers
 *      the text's position.
 *   2. Slotted text inherits through the flat tree: its rendered colour comes from the
 *      shadow element owning the receiving <slot>, not from the light-DOM host.
 *   3. A backgrounded tab freezes CSS transitions (and rAF), so a theme switch measured
 *      too early reports the previous theme mid-interpolation. Transitions are disabled for
 *      the duration and waits are timer-based.
 *
 * Disabled/low-opacity controls are skipped (WCAG 1.4.3 exempts inactive UI) and counted,
 * so the exemption cannot hide a real failure.
 */

const FROZE_ID = "nu-audit-freeze";

function makeHelpers() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    const memo = new Map();
    const toRgba = (css) => {
        if (memo.has(css)) return memo.get(css);
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = "#010101";
        cx.fillStyle = css;
        if (cx.fillStyle === "#010101") { memo.set(css, null); return null; }
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        const v = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        memo.set(css, v);
        return v;
    };
    const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const over = (dst, src) => ({
        r: src.r * src.a + dst.r * (1 - src.a),
        g: src.g * src.a + dst.g * (1 - src.a),
        b: src.b * src.a + dst.b * (1 - src.a),
    });
    const composedParent = (el) => {
        const p = el.assignedSlot || el.parentNode;
        if (p instanceof ShadowRoot) return p.host;
        return p instanceof Element ? p : null;
    };
    /** The shadow element that actually paints our text: the slot that receives it. */
    const paintSource = (el) => {
        if (!el.shadowRoot) return el;
        for (const slot of el.shadowRoot.querySelectorAll("slot")) {
            const nodes = slot.assignedNodes({ flattened: true });
            if (nodes.some((n) => n === el.firstChild || (n.nodeType === 1 && el.contains(n)) || (n.nodeType === 3 && n.textContent.trim()))) {
                return slot.parentElement || slot;
            }
        }
        return el;
    };
    return { toRgba, ratio, over, composedParent, paintSource };
}

function auditOnce() {
    const { toRgba, ratio, over, composedParent, paintSource } = makeHelpers();
    const all = [];
    const walk = (el) => {
        all.push(el);
        if (el.shadowRoot) for (const k of el.shadowRoot.children) walk(k);
        for (const k of el.children) walk(k);
    };
    for (const k of document.documentElement.children) walk(k);

    const rec = new Map();
    for (const el of all) {
        const cs = getComputedStyle(el);
        rec.set(el, cs.display === "none" || cs.visibility === "hidden" ? null : { cs, rect: el.getBoundingClientRect() });
    }

    // Painted layers that live inside a shadow tree (containers, state layers).
    const layers = new Map();
    for (const el of all) {
        if (!el.shadowRoot) continue;
        const list = [];
        const sw = (e) => {
            const r = rec.get(e);
            if (r) {
                const c = toRgba(r.cs.backgroundColor);
                if (c && c.a > 0 && r.rect.width > 0) list.push({ el: e, rect: r.rect, c, op: Number(r.cs.opacity) || 0 });
            }
            for (const k of e.children) sw(k);
        };
        for (const k of el.shadowRoot.children) sw(k);
        if (list.length) layers.set(el, list);
    }

    let base = { r: 255, g: 255, b: 255 };
    for (const b of [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]) {
        const c = toRgba(b);
        if (c && c.a > 0) base = over(base, c);
    }

    const rows = [];
    let exempt = 0;
    for (const el of all) {
        let text = "";
        for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
        text = text.trim();
        if (!text) continue;
        const r = rec.get(el);
        if (!r) continue;
        if (el.closest("[disabled],[aria-disabled=\"true\"]")) { exempt++; continue; }
        const rect = r.rect;
        if (rect.width < 3 || rect.height < 3) continue;

        const src = paintSource(el);
        const scs = src === el ? r.cs : getComputedStyle(src);
        const fg = toRgba(scs.color);
        if (!fg || fg.a <= 0) continue;
        let op = Number(scs.opacity);
        for (let a = composedParent(el); a && op > 0.02; a = composedParent(a)) op *= Number(getComputedStyle(a).opacity) || 1;
        if (op < 0.99) { exempt++; continue; }

        const up = new Set();
        for (let a = composedParent(el); a; a = composedParent(a)) up.add(a);
        const x = rect.right - 1;
        const y = rect.bottom - 1;
        const chain = [];
        for (let a = el; a; a = composedParent(a)) chain.push(a);
        chain.reverse();

        let bg = base;
        for (const anc of chain) {
            const ar = rec.get(anc);
            const self = toRgba(ar ? ar.cs.backgroundColor : getComputedStyle(anc).backgroundColor);
            if (self && self.a > 0) bg = over(bg, { r: self.r, g: self.g, b: self.b, a: self.a * (ar ? Number(ar.cs.opacity) : 1) });
            const cand = layers.get(anc);
            if (!cand) continue;
            for (const L of cand) {
                if (L.el === el || up.has(L.el) || L.el.contains(el)) continue;
                if (!(x >= L.rect.left && x < L.rect.right && y >= L.rect.top && y < L.rect.bottom)) continue;
                bg = over(bg, { r: L.c.r, g: L.c.g, b: L.c.b, a: L.c.a * L.op });
            }
        }

        const px = parseFloat(r.cs.fontSize) || 14;
        const isIcon = el.tagName.toLowerCase() === "md-icon";
        const need = isIcon || px >= 24 || (px >= 18.66 && Number(r.cs.fontWeight) >= 700) ? 3 : 4.5;
        const rr = ratio(fg, bg);
        rows.push({
            label: text.slice(0, 20),
            tag: el.tagName.toLowerCase(),
            need,
            ratio: Math.round(rr * 100) / 100,
            ok: rr >= need,
            fg: `rgb(${fg.r},${fg.g},${fg.b})`,
            bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
        });
    }
    rows.sort((a, b) => a.ratio - b.ratio);
    const fails = rows.filter((q) => !q.ok);
    return {
        samples: rows.length,
        exempt,
        min: rows.length ? rows[0].ratio : null,
        fails: fails.length,
        worst: fails.slice(0, 6).map((f) => `${f.tag} "${f.label}" ${f.ratio}<${f.need} ${f.fg} on ${f.bg}`),
    };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = ["workflow", "generate", "models", "prompt", "gallery", "settings"];
const state = { done: false, at: "idle", rows: [] };

/** Sweep every view in both themes. Returns immediately; poll with progress()/results(). */
export async function run({ settleMs = 400, viewMs = 950 } = {}) {
    if (!document.getElementById(FROZE_ID)) {
        const st = document.createElement("style");
        st.id = FROZE_ID;
        st.textContent = "*,*::before,*::after{transition:none !important;animation:none !important}";
        document.head.appendChild(st);
    }
    state.done = false;
    state.at = "start";
    state.rows = [];
    (async () => {
        for (const theme of ["m3-dark", "m3-light"]) {
            document.documentElement.dataset.theme = theme;
            await wait(settleMs);
            for (const view of VIEWS) {
                location.hash = "#/" + view;
                await wait(viewMs);
                state.at = `${theme}/${view}`;
                try {
                    const res = auditOnce();
                    res.theme = theme;
                    res.view = view;
                    state.rows.push(res);
                } catch (err) {
                    state.rows.push({ theme, view, error: String(err).slice(0, 110) });
                }
                await wait(20);
            }
        }
        document.documentElement.dataset.theme = "m3-dark";
        location.hash = "#/workflow";
        document.getElementById(FROZE_ID)?.remove();
        state.at = "done";
        state.done = true;
    })();
    return { started: true, views: VIEWS.length * 2 };
}

export function progress() {
    return { done: state.done, at: state.at, counted: state.rows.length };
}

export function results() {
    return state.rows.map((o) => (o.error
        ? `${o.theme}/${o.view} ERROR ${o.error}`
        : `${o.theme}/${o.view} n=${o.samples} exempt=${o.exempt} min=${o.min} fails=${o.fails}${o.fails ? "\n  " + o.worst.join("\n  ") : ""}`));
}

/** Arm the audit: force a colour that must fail, and report whether it does. */
export function selfTest() {
    const st = document.createElement("style");
    st.textContent = "*,*::before,*::after{transition:none !important;animation:none !important}";
    document.head.appendChild(st);
    document.documentElement.dataset.theme = "m3-light";
    const clean = auditOnce();
    const bad = document.createElement("style");
    bad.textContent = ".nu-rail__item { color: #cac4d0 !important }";
    document.head.appendChild(bad);
    const armed = auditOnce();
    bad.remove();
    st.remove();
    document.documentElement.dataset.theme = "m3-dark";
    return { cleanFails: clean.fails, armedFails: armed.fails, armedWorst: armed.worst.slice(0, 2), armed: armed.fails > clean.fails };
}
