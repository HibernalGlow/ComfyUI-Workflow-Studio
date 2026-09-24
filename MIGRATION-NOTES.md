# MIGRATION-NOTES

Record of the ComfyUI-Workflow-Studio frontend refactor, **route v2**, and of the
ongoing **upstream port tax** described in `FRONTEND-OPTIMIZATION-BRIEF.md` §0.

- Upstream: `ketle-man/ComfyUI-Workflow-Studio` (`upstream/main`).
- This file is the authoritative record of **where the implementation departs from
  the original brief and why.** The brief itself was left byte-identical: it is the
  input, not a spec to keep in sync.

---

## 1. Route reversal — the brief's §10 prohibitions were overturned deliberately

`FRONTEND-OPTIMIZATION-BRIEF.md` §10 forbade React/Svelte/Vue/Tailwind/component
libraries/bundlers, and specifically forbade `@material/web`, on the grounds that
upstream has no build step. **On 2026-09-25 the owner overturned that decision** for
this fork: the new UI is React 19 + `@material/web` + TypeScript + Vite, built locally,
with the built output **not committed**.

What the original argument got right, and what it did not:

| Claim in §10 | Verdict |
|---|---|
| A bundler would create merge conflicts with upstream | **Wrong.** Conflicts depend on which files a commit touches, not on the toolchain. The new UI is entirely new paths either way; measured `A1` did not move. |
| A bundler costs the "no build step" property | **Right**, and that property is genuinely lost. See the cost list below. |
| `@material/web` would introduce a second token system | **Partly wrong in practice.** material-web resolves colours as `var(--md-filled-button-container-color, var(--md-sys-color-primary, #6750a4))`, i.e. a two-level fallback onto the standard `--md-sys-color-*` names — so the hand-generated M3 token/theme CSS drives it directly, and **no sass pipeline was needed.** |
| A framework would fix the coupling problem | **Wrong.** The old UI's 1319 element ids were a design failure, not a tooling failure. What fixed it is the `core`/UI boundary in §2, which is framework-free by construction. |

### Costs accepted

1. **The repo is no longer a clone-and-use ComfyUI plugin for the new UI.** `static/newui.html`
   and `static/newui/` are generated; a fresh clone must run `pnpm install && pnpm build`
   before `/wfm_static/newui.html` exists. Accepted because this fork is single-user, and
   because the old UI at `/wfm` is untouched and still works from a bare clone (§4).
2. **Toolchain surface.** pnpm + Vite + TypeScript 7 + Babel/React-Compiler now sit in the
   dependency graph, plus a 4 MB self-hosted Material Symbols variable font (subsetting is
   a known follow-up).
3. **Build output hygiene.** `emptyOutDir` is deliberately `false` because the outDir is the
   live `static/` folder that also holds the old UI's files; wiping it would break `/wfm`.
   Staleness is instead handled by a `prebuild` step that removes only `static/newui`.
   `pnpm exec vite build` bypasses `prebuild`, so a rebuild **must** go through `pnpm build`.

### Facts established during the选型 (not assumptions)

| Package | State as of 2026-09-24 |
|---|---|
| `@mui/material-next` | **deprecated**: "The work on this npm package has stopped." MUI has no MD3 implementation. |
| `@mui/material` | 9.4.0, active — but Material 2. |
| `@material/web` | 2.5.0, active (published 2026-09-24). Chosen. |
| `typescript` 7.0.2 | Confirmed to be the native Go port: `main` is undefined, 20 `@typescript/typescript-<os>-<arch>` binary optionalDeps, 3.5 MB, ships `vendor/`. Consequence: the old JS compiler API is gone, so type checking runs through the `tsc` CLI, not `vite-plugin-checker`. |
| `babel-plugin-react-compiler` | 1.0.0 (stable). Used via `@rolldown/plugin-babel` + `reactCompilerPreset()`. |
| Vite `compiler: true` | Rejected: it is a *Rust port* of React Compiler marked experimental, and pins `oxc-transform-react@^0.145` while 0.151 is current. |

**Gaps found inside material-web 2.5.0** (verified against its own file list and typings):
there is **no snackbar**, **no tooltip**, and **no navigation rail** — `md-navigation-drawer`
exposes only `opened`/`pivot` and has no rail variant, `md-navigation-bar` is a bottom bar.
So `frontend/src/snackbar.tsx` implements the M3 snackbar, the rail is hand-built in
`theme.css` + `App.tsx` from M3 tokens, and tooltips are still open (§5).

Also corrected from the spec-gathering pass: the brief §4 note 3 claim that aiohttp's
`add_get` does not auto-handle HEAD is **not true**; the real reason upstream loads previews
with `img.onload/onerror` is to avoid 404 console spam. The technique is kept, the reasoning
in the brief is wrong. And upstream has **no pagination at all** (`state.currentPage` is
written 11 times and never read), so §4 item 16 is greenfield, not a port.

---

## 2. What survived the route change, and what did not

| Asset | Size | Fate |
|---|---|---|
| `static/js/core/**` — 15 modules, DOM-free, reached only through `core/index.js` | ~3.5k lines + 46 unit tests | **kept whole.** Framework-free by rule B1, which is exactly why it transferred. |
| `static/js/core/CONTRACT.md`, `CONTRACT-api.md` | 2 docs | kept, updated to v2 gates |
| `static/css/newui/m3-tokens.css` + `theme-m3.css` | ~890 lines | **kept and load-bearing** — they supply the `--md-sys-color-*` layer material-web falls back to |
| `static/css/newui/{m3-layout,m3-components,newui}.css` | ~3.4k lines | discarded; the library owns component styling |
| 22 hand-written M3 components + 4 primitives + shell/views | ~7k lines | discarded, moved to `frontend/legacy-vanilla-views/` as a behaviour reference; **never imported** |
| `tools/check-newui.sh`, `tools/core-tests/` | — | kept, retargeted at `frontend/src` |

The boundary that made this transfer possible: **`core/` may not touch the DOM**
(rule B1). Because every generation/style/wildcard/batch/model behaviour was pushed
into DOM-free modules first, replacing the entire view layer was a swap, not a rewrite.

---

## 3. The one permanent tax: porting upstream UI fixes (~38% of commits)

`py/` (25% of upstream commits), `templates/index.html` (49%), `i18n.js` (48%) and the
retired tabs (11%) cost nothing: the backend is untouched, the new shell is a separate
generated file, `t()` inherits new keys automatically, and retired tabs never appear.

The 6 tabs the new UI does implement account for ~38% of upstream commits, and those
UI-side changes must be hand-ported.

### How to port one upstream fix

1. `git fetch upstream && git log --oneline HEAD..upstream/main -- <path>`.
2. Classify the diff:
   - backend / i18n / retired tab → nothing to do;
   - pure logic (a `core/` concern) → port into `static/js/core/**`, still DOM-free;
   - view behaviour → port into `frontend/src/views/*.tsx`.
3. **Never edit an upstream-owned file to make a port easier** — that is what breaks the
   zero-conflict property.
4. `pnpm build` (typecheck + build) and `bash tools/check-newui.sh`, then the merge dry run.
5. Since `static/newui/` is not committed, a port produces a source-only diff: reviewable,
   and it cannot collide with an upstream commit that happens to touch the same area.

### Port ledger

| Date | Upstream range | Upstream files changed | Ported into | Notes |
|---|---|---|---|---|
| — | baseline: no upstream commit merged since the fork point | — | — | open this ledger at the first upstream release after the switch |

---

## 4. Decisions taken during implementation that the brief left open

| # | Decision | Why |
|---|---|---|
| D1 | UI preferences use a `nu_` prefix via `core/settings.js` (`readPref`/`writePref`) instead of raw keys. | Brief §10 forbids the old UI's keys; one accessor keeps that rule checkable (gate A5d). |
| D2 | The badge **palette** is not migrated from `wfm_models_badge_palette`; the UI starts from `nu_models_badge_palette`. | Same rule. Badge *assignments*, tags, memos and favourites are server-side metadata and carry over regardless — only custom label→colour pairs must be re-entered. **Known side effect:** the old UI's Workflow tab shares that key, so the two UIs can show different colours for the same badge label until re-entered. |
| D3 | `wfm_settings` **is** shared (read + write) with the old UI. | Brief §1.2 requires the new UI to connect with the address the user already saved; without it the page cannot reach ComfyUI at all. |
| D4 | Binary endpoints are exposed in `core/api.js` as **URL builders**, not fetches. | The view assigns them to `img.src` / `<a href>`; buffering them in JS would be pure loss. |
| D5 | `runGeneration()` returns the workflow it actually used, in addition to images/seed/svgOutputs. | Brief §2.2 rule 5: the UI owns state, core stays stateless — so core must hand back what it mutated. Upstream `_coreGenerate` returned only `{images, seed}` and dropped `svgOutputs` entirely. |
| D6 | `core/models.js` carries pure helpers (`withTag`, `withBadge`, `groupsOf`, `civitaiUrl`, `genUiTarget`, `appendEmbedding`, `decorate`) as well as api wrappers. | Brief §4 note 2 turns `applyToGenUI` into "a pure core call + store update"; the pure half has to live somewhere DOM-free. |
| D7 | `core/` may touch `localStorage`, but only inside `core/settings.js`. | The §2.2 rule is about element access; preference persistence is unavoidable and one file makes it auditable. |
| D8 | Preview thumbnails use `img.onload`/`img.onerror`, not a HEAD probe. | Kept from upstream, for the reason in §1 (404 spam), not the reason the brief gives. |
| D9 | No cleanup phase. Nothing upstream-owned was deleted. | Deleting upstream files is the point of formally abandoning upstream merges. |
| D10 | `comfyUI.currentWorkflow` / `currentAnalysis` are written only through `frontend/src/coreBridge.ts`. | `pipeline.js` still reads the upstream client's graph state, but the JS initialises both to `null`, so TypeScript infers `null` and rejects assignment. One named seam instead of scattered casts. |
| D11 | `tr(key, fallback)` added to `core/i18n.js`. | The brief §3.2 rule 6 assumed `t("key", "fallback")` yields the fallback. It does not: upstream `t(key, ...args)` treats extra args as `{0}` substitutions and returns the **key** when unmapped. `tr()` gives text that is new to this fork a real English fallback while still preferring upstream translations once they exist. |
| D12 | React Compiler runs through Babel (the reference implementation), not Vite's `compiler: true`. | See §1. |

---

## 5. Known deviations and open work

Implemented but not yet at the standard the rest of the app should hold:

1. The Generate parameter form is generated from the workflow's own primitive inputs. It does
   **not** yet consult ComfyUI `object_info` for per-input min/max/step/combo options, so the
   numeric widgets are weaker than the old editor's.
2. Tooltips are not implemented (material-web has none).
3. `tools/check-newui.sh` scopes the DOM-literal gate to `*.js`, because the brief's literal
   command also matches the words when they appear as *prose* in `CONTRACT.md`. The gate is
   about executable modules; the prose is kept free of the banned identifiers anyway.

Closed since the first draft of this list: `window.confirm`/`window.prompt` became `md-dialog`
surfaces (gate A5f now fails on any `window.confirm|prompt|alert`); the Batch panel is wired to
`core/batch.js`; "Apply to GenerateUI" hands off through the `useSyncExternalStore` store
instead of the `nu_pending_apply` localStorage key.

### 5.1 Browser verification log — 2026-09-25

Measured against the built bundle at `/wfm_static/newui.html`, not the dev server.

| Item | Result |
|---|---|
| 6 views mount (`#/workflow…#/settings`) | ok — each renders `.nu-view` |
| m3-dark contrast, all 6 views | ok — 0 failures, worst 7.21:1 (287 text samples) |
| m3-light contrast, all 6 views | ok — 0 failures, worst 5.81:1 (287 text samples, same coverage) |
| audit armed, foreground side | ok — forcing `.nu-rail__item{color:#cac4d0}` in m3-light gives 5 failures at 1.46:1 naming the right icons; removing it gives 0 again |
| audit armed, background side | ok — forcing `.nu-rail{background:primary}` gives 5 failures at 1.45:1 |
| tab order | ok — DOM order, no positive `tabindex`, no `role=button` outside the native focus order |
| visible focus ring | ok — a *real* Tab puts a `2px solid primary` outline on the rail item and `:focus-visible` matches |
| accessible names | ok — rail items read 工作流/生成UI/模型/提示词/图库/设置, header buttons carry `aria-label` |
| rollback entry | ok — the header's "Open the previous interface" reaches `/wfm`, which still mounts `js/app.js` with its own tab strip |
| dialog focus trap | ok — with `md-dialog` open, Tab from the **last** control (Save) wrapped to the dialog's own input; focus never escaped |
| dialog focus restore | was **broken**, now ok — Escape used to leave focus on `<body>`; `dialogs.tsx` now hands focus back to the opener after teardown (see §6) |
| console | no JS exceptions. Only HTTP-level noise: `404` on `/api/wfm/models/preview` for models that have no stored preview (the grid falls back to the `image_not_supported` placeholder, which is why those icons are there), and `502` during the tunnel blip below |
| brief §6 12-row parity table | **not closed** — rows 3, 8, 9 and 12 require real generation runs (GPU time on the compute box), which were not started without the user's go-ahead |
| Models' 18 items (brief §4) | partially — 8 types, grid+table, pagination, favourite, badges, groups, detail panel, Batch/Stack toggles and Civitai fetch are present and rendered against live data; per-item behaviour has not been walked against upstream one by one |

Coverage note: an earlier pass of this table ran while `127.0.0.1:8188` was refusing
connections (the node bridge on `:8000` answered `502` for every API, including
`/object_info` and `/prompt`, while still serving the static bundle). That pass sampled only
17 nodes on `#/workflow` in m3-light because the list had not loaded; it was re-run after the
backend recovered, which produced the equal 287/287 coverage above. The bridge, the SSH tunnel
and Tailscale were all healthy — the stopped service was ComfyUI itself on the Windows box.

Three rounds of the contrast audit reported failures that turned out to be artifacts of the
audit rather than of the design. They are recorded because anyone re-measuring will hit them
again:

1. **Shadow-painted backgrounds.** `@material/web` paints a control's container colour on a
   `.background` box inside its own shadow root, which is a *sibling* of the label and never an
   ancestor. Walking up from the text therefore lands on the page body and reports ~1.4:1 for
   tokens that are fine. The audit must descend into `shadowRoot` and composite the boxes that
   geometrically cover the text, multiplying each one's `opacity`.
2. **Slotted text inherits through the flat tree.** The rendered label colour comes from the
   shadow element that owns the *receiving* `<slot>` (`.label`), not from the light-DOM host.
   Reading `getComputedStyle(host).color` yields the inherited page colour (on-surface) and
   makes every filled button look like a catastrophic failure. Pick the slot that actually
   receives the text node — `querySelector('slot')` returns the icon slot first.
3. **A backgrounded tab freezes transitions and `requestAnimationFrame`.** `.nu-rail__item`
   declares `transition: color …`, so switching `data-theme` from a script in a hidden tab left
   the colour part-way between themes — serialised as `oklab(…)`, unlike the `lab(…)` tokens —
   and reported the *previous* theme indefinitely. Inject `transition:none; animation:none` for
   the duration of the audit and wait on timers, never on `rAF`.

Disabled controls are excluded per WCAG 1.4.3's exemption for inactive UI, and counted
separately (6–8 per view) so the exemption cannot silently hide a real failure.

Explicitly out of scope per brief §5: Nodes, Image Edit, Video, Tagger, Metadata, AI TOOL,
Feeder, Help, plus the Generate view's `Lab` sub-tab and the Prompt `Table` view.

---

## 6. Incidents worth recording

- **`md-dialog` does not restore focus for a portal dialog.** The dialogs in `frontend/src/dialogs.tsx`
  are mounted into a detached `<div class="nu-dialog-portal">` by `createRoot`, so the component's own
  "focus what was focused before `show()`" path and our teardown fight over it. Two orderings were
  tried and measured before the working one: restoring *before* unmount was a silent no-op, and
  restoring *after* unmount guarded on `document.activeElement === document.body`, which React 19's
  asynchronous `unmount()` had not yet made true. Focusing the opener after `host.remove()`, with no
  guard, is what a real Escape keypress now confirms. Lesson: an async `unmount` makes every
  "the DOM is gone now" assumption in the same tick wrong.
- **Two rounds of "contrast failures" were my measurement, not the theme.** See §5.1 — shadow-painted
  containers, slotted-text inheritance, and a backgrounded tab freezing `transition: color`. Each one
  produced a confident-looking number (1.31:1 on every filled button; 1.47:1 on the nav icons) that
  dissolved under a direct probe of the same element. The fix was not to trust the aggregate: re-measure
  one element by a second method, then arm the audit by forcing a colour that *must* fail.

- **Package-manager race (self-inflicted).** During the npm→pnpm migration an
  `npm install` started in the background finished *after* `pnpm install`, and rewrote the
  top level of `node_modules` in npm's layout — `vite` disappeared and the next build failed
  with `Cannot find module .../node_modules/vite/bin/vite.js`. Repaired with
  `rm -rf node_modules && pnpm install`. Lesson: never leave an installer from the manager
  being migrated away from in flight.
- **`yarn.lock` was modified with no explanation, then removed.** During the npm phase the
  tracked `yarn.lock` (a fork-owned file; it is **not** in `upstream/main`) grew from 1.3 KB
  to 25 KB. Stock npm does not write yarn.lock, and no cause was established. It is deleted
  as part of the pnpm switch; the committed content is preserved at
  `/tmp/wfm/yarn.lock.HEAD` for this session and remains recoverable with
  `git show HEAD:yarn.lock`. Its only entries were `http-proxy` and its 3 dependencies.
- **Two false greens found and fixed in the gates themselves.** (a) The old
  `check-newui.sh` grepped `static/js/newui/`, which no longer exists, so every debt gate
  "passed" against an empty tree — the gates now target `frontend/src` and each is preceded
  by a probe that fails loudly if its tree is missing. (b) `node --test tools/core-tests/`
  reported success when zero test files existed; the test gate now requires ≥40 passing and
  0 failing. A third, `import-check.mjs`, was still scanning the discarded tree.
- A `rg`/GNU-`grep` alias difference made one gate report "NO FONT ASSET" when the woff2 was
  in fact emitted correctly; verified by listing the output directory directly.

---

## 7. Rollback

The old UI is untouched and remains the default entry at `/wfm`
(`templates/index.html:3475` → `/wfm_static/js/app.js`). The new UI is *additional*:
`static/newui.html` plus a generated asset folder. Rolling back = stop visiting that URL;
no data migration is involved, and no old-UI file, route or storage key was repurposed.
Keep `/wfm` for at least two weeks after switching (brief §9 P6).

---

## 8. Commands

```bash
pnpm install                 # deps (pnpm is the package manager; packageManager field pins it)
pnpm build                   # tsc --noEmit && vite build   (use this, not `pnpm exec vite build`)
pnpm build:watch             # rebuild into static/ on change
pnpm dev                     # serve static/ + reverse-proxy ComfyUI (default http://127.0.0.1:8188)
                             # then open http://localhost:8000/wfm_static/newui.html
pnpm test:core               # node --test tools/core-tests/
bash tools/check-newui.sh    # every mechanical gate
RUN_MERGE_DRY=1 bash tools/check-newui.sh
```
