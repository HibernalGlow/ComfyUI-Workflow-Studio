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
| `static/js/core/**` — 15 modules, DOM-free, reached only through `core/index.js` | ~3.7k lines; 46 unit tests at handover, **99 now** | **kept whole.** Framework-free by rule B1, which is exactly why it transferred. |
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

1. Tooltips are not implemented (material-web has none); the header buttons carry native
   `title`/`aria-label` instead.
2. `tools/check-newui.sh` scopes the DOM-literal gate to `*.js`, because the brief's literal
   command also matches the words when they appear as *prose* in `CONTRACT.md`. The gate is
   about executable modules; the prose is kept free of the banned identifiers anyway.

Closed since the first draft of this list: `window.confirm`/`window.prompt` became `md-dialog`
surfaces (gate A5f now fails on any `window.confirm|prompt|alert`); the Batch panel is wired to
`core/batch.js`; "Apply to GenerateUI" hands off through the `useSyncExternalStore` store
instead of the `nu_pending_apply` localStorage key; and the Generate form is now constrained by
ComfyUI's own `/object_info` — `core/widgets.js` resolves each input to a widget kind with its
`min`/`max`/`step`/option list, so combos render as `md-outlined-select`, numbers as ranged
fields with the range shown as supporting text, and multiline strings as textareas. The old
editor hard-codes its bounds for the handful of sampler/latent fields it knows (`steps` 1–200,
`width` step 8 …); this reads them from the server for every node.

### 5.1 Browser verification log — 2026-09-25

Measured against the built bundle at `/wfm_static/newui.html`, not the dev server.

| Item | Result |
|---|---|
| 6 views mount (`#/workflow…#/settings`) | ok — each renders `.nu-view` |
| m3-dark contrast, all 6 views, **live backend** | ok — 0 failures, worst 7.21:1 (317 text samples over 6 views) |
| m3-light contrast, all 6 views, **live backend** | ok — 0 failures, worst 5.81:1 (318 text samples, same coverage) |
| same audit against a **dead** backend | 276 samples, also "0 failures" — which is exactly why it is not the number of record. An empty `#/workflow` yields 18 samples, a loaded one 142 (see §6) |
| exempted (disabled / opacity) samples, live pass | 46 across the 12 view×theme rows, counted separately so the WCAG 1.4.3 exemption cannot hide a real failure |
| audit armed, foreground side | ok — forcing `.nu-rail__item{color:#cac4d0}` in m3-light gives 5 failures at 1.46:1 naming the right icons; removing it gives 0 again |
| audit armed, background side | ok — forcing `.nu-rail{background:primary}` gives 5 failures at 1.45:1 |
| tab order | ok — DOM order, no positive `tabindex`, no `role=button` outside the native focus order, on all 6 views |
| visible focus ring | ok — a *real* Tab puts a `2px solid primary` outline on the rail item and `:focus-visible` matches |
| accessible names | ok — 0 unnamed focusable controls on every view after labelling the Workflow JSON editor (it was a bare `<textarea class="nu-code">`, which the sweep caught as the single nameless control) |
| keyboard reach of the loaded parameter form | ok — all 62 fields (50 text fields, 9 selects, 3 switch rows) are reachable: every material-web host reports `delegatesFocus: true` with a focusable inside, and focusing it yields `md-outlined-text-field>input` |
| console | clean — a fresh load swept over all 6 views reported **zero** console messages (no errors, no warnings, no failed requests). An earlier run showed only HTTP-level noise: `404` on `/api/wfm/models/preview` for models with no stored preview (the grid falls back to the `image_not_supported` placeholder), and `502` during the tunnel blip below |
| rollback entry | ok — the header's "Open the previous interface" reaches `/wfm`, which mounts `js/app.js` and renders with **live data**: all 12 upstream tabs (工作流/节点/模型/生成UI/提示词/图库/Image Edit/Video/Tagger/设置/帮助/AI TOOL), 128 workflow rows, 15 thumbnails, and its own `wfm_*` localStorage keys still in use |
| responsive shell | measured live at a 319 px viewport: `.nu-rail` 56 px, `.nu-rail__label` computed `display: none`, icon tile 48 px, rail item 56×56, `.nu-main` 263 px, top bar 64 px, `grid-template-columns: 56px 263px`, and no horizontal document overflow. The cascade half is now a unit test (`responsive: the nav rail collapses at its declared breakpoint`): the `@media (max-width: 839px)` block must hide the labels, narrow `--nu-rail-width` to 56 px and grow the icon, while the *base* `.nu-rail__label` rule must not hide them — otherwise the breakpoint hides nothing. Armed by rewriting that one declaration to `display: revert`: the test goes red on "labels are what collapses", and the file came back byte-identical. **What is NOT measured:** the >839 px state in this session — the tab is 319 px wide, a sized `window.open` popup is blocked without a user gesture, and a hidden tab offers no screenshot surface. The earlier contrast/keyboard rows in this table were taken at a normal desktop width, so the wide layout was lived through then, not asserted now. |
| dialog focus trap | ok — with `md-dialog` open, Tab from the **last** control (Save) wrapped to the dialog's own input; focus never escaped |
| dialog focus restore | was **broken**, now ok — Escape used to leave focus on `<body>`; `dialogs.tsx` now hands focus back to the opener after teardown (see §6) |
| parity item 1 — workflow JSON → parameter form | ok — `Anima文生图.json` and `Anima批量图像出图.json` each yield 44 node sections / 94 editable fields, of which 58 are server-constrained (29 `md-outlined-select` combos, 29 ranged numbers, 8 multiline textareas) |
| brief §6 12-row parity table | see §5.2 for the per-row ledger — 8 rows closed, 3 gated on a generation run, 1 on a server restart |
| Models' 18 items (brief §4) | ok as implemented for all 18, exercised live for 16 — 8 type tabs, grid⇄table (9 sortable columns) + `nu_models_view`, ★/Batch filters, select-mode, per-card Batch/Stack chips, detail panel (subdir·ext, "+ group…", Apply to Generate, Civitai, disable), pagination with a 24/48/96/200 page-size select, lazy previews (an `img` plus the placeholder fallback for the checkpoint that has none), and six filter selects (tag / badge / **dir, fed by `/api/wfm/models/subdirs`** / group / status / page size). Not clicked because they write to the compute box: batch Civitai fetch (item 9) and bulk move-to-subdir (item 18), both unit-covered at the API layer |

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

4. **A material-web host is not the tab stop.** `md-outlined-text-field` and `md-outlined-select`
   report `tabIndex === -1` on the host and delegate focus into their shadow tree, so a
   "count the focusables" sweep saw 9 controls on a view holding 62 editable fields. Reachability
   is real (all 59 hosts have `delegatesFocus: true` with a focusable inside); the filter was
   wrong. Same class of miss as a chip sweep that queried `button` and so skipped
   `md-filter-chip` entirely.

Disabled controls are excluded per WCAG 1.4.3's exemption for inactive UI, and counted
separately (6–8 per view) so the exemption cannot silently hide a real failure.

The audit is now a committed, self-arming tool — `tools/contrast-audit.mjs`:

```
cp tools/contrast-audit.mjs static/newui/          # gitignored build dir; served by /wfm_static
# in the page console:
const m = await import("/wfm_static/newui/contrast-audit.mjs");
await m.run();            // sweeps 6 views × 2 themes; poll with m.progress()
m.results();              // one line per view/theme, with the worst offenders
m.selfTest();             // forces a bad colour and proves the audit can go red
```

`selfTest()` was run against a *loaded* workflow form (20 node sections / 62 fields) in
m3-light: 0 failures clean, 5 failures once `.nu-rail__item` is forced to `#cac4d0`. The
earlier sweeps measured the views in their default state, so the parameter form itself is now
covered too — but note the sweep navigates without `?workflow=`, so re-run `selfTest()` on a
loaded workflow whenever the form changes.

Re-run after the presets card, the chip fix and the labelled JSON editor (the newest build):
12/12 view×theme combinations clean again, 0 failures everywhere, worst 7.21:1 dark / 5.81:1
light, and `selfTest()` still reports 0 clean vs 5 armed. The console stayed empty through the
whole sweep. That pass measured 287 samples; the axe round below then exposed that part of it ran
against a dropped tunnel, so it was run a third time behind the liveness gate — 635 samples,
12/12 clean, same worst values, `selfTest()` still 0 clean / 5 armed.

`run()` also used to resolve *before* the sweep finished (it launched the loop and returned
`{started: true}`), so `await m.run()` proved nothing while `progress()` kept climbing — that is
why the void pass above looked finished. It now returns the row list when the last view is done,
and throws up front if `/system_stats` does not answer.

Explicitly out of scope per brief §5: Nodes, Image Edit, Video, Tagger, Metadata, AI TOOL,
Feeder, Help, plus the Generate view's `Lab` sub-tab and the Prompt `Table` view.

#### axe-core pass — same day, on the live backend

`axe-core@4.13.0` (fetched as a tarball into `/tmp`, copied into the gitignored
`static/newui/`; `git check-ignore` proves it cannot be committed — no dependency was added to
`package.json`) run over all 6 views plus `#/generate?workflow=Anima文生图.json`:

| Stage | Result |
|---|---|
| first run, before any fix | 4 rule families across 7 routes: `page-has-heading-one` (7/7 routes), `aria-progressbar-name` (models, prompt), `link-name` (settings, 2 nodes), `color-contrast` (generate, the disabled readout's caption at 3.05:1) |
| after the fixes, dead backend | 7/7 routes clean — **but this pass is void** (see §6: the tunnel had dropped, so the views were shells) |
| after the fixes, live backend (`63` workflows, `3218` `/object_info` classes as the gate) | **7/7 routes, 0 violations** |
| the loaded parameter form specifically | 65 controls (53 text fields, 9 selects, 3 switches) across 20 node cards, **0 violations** — the first two passes had scanned it at 3 controls because the route was given 9 s and `/object_info` alone takes 12.7 s / 16 MB on this link |
| `axe` incompletes on the form, recorded so nobody re-investigates them | 9 × `aria-valid-attr-value`: every `md-outlined-select` carries `aria-controls="listbox"` and the listbox exists only inside the component's shadow tree while open, which axe cannot resolve. 124 × `color-contrast`: axe will not composite the shadow-painted `.background` boxes — exactly the shadow boundary the audit in §5.1 was written to cross |

What the fixes were, and why each is more than a scanner appeasement:

- `<h1>` — the top-app-bar title was a `<span>`; the document had no level-one heading on any
  route, and the views' own `<h2 class="nu-card__title">` headings therefore had no parent. Now
  exactly one `h1` per view, geometry unchanged (measured 122×28 inside the same 64 px bar).
- `aria-label` on all 9 `md-linear-progress` usages — a progressbar with no name announces
  nothing; each now says what is loading (`Loading`, `Civitai metadata`, `Batch progress`,
  `Generation progress`).
- `aria-label` on the two Settings export anchors — see §6: their visible label is slotted into a
  `md-outlined-button`, which axe's name computation does not flatten.
- `.nu-readout` — the workflow readout's caption is now legible instead of exempted; see §6 for
  the two dead ends tried first.

Re-checked on this build (the DOM changed, so the keyboard record is not inherited): a real
`Tab` keypress moved focus to `md-icon-button[Toggle colour scheme]`, 0 elements carry a positive
`tabindex`, the loaded Generate form exposes 58 `input`/`textarea`/`select` stops with the disabled
readout excluded from the chain (`inner.focus()` on it leaves `document.activeElement` on `<body>`),
and the form took 13 s of `/object_info` (16 MB) plus a 23 s `/api/wfm/workflows` before those
stops existed at all. One correction to an older row here: for `md-*` hosts the visible ring comes
from the library's own `:focus-visible` overlay inside the shadow tree — `getComputedStyle(host)
.outlineStyle` is `none` even while the control is drawn focused, so that property is not a usable
probe for material-web components (it is correct for the native `.nu-rail__item` buttons).

---

### 5.2 Parity ledger — brief §6's 12 rows

"unit" = asserted by `node --test tools/core-tests/` (99 tests); "live" = observed in the
browser against the built bundle; "A1" = the upstream-hash baseline gate proving the named
upstream file is byte-identical. Two of those tests are a **cross-language route gate**: they
parse every `request()` path/method out of `core/api.js` (93 call sites, 9 of them templated)
and match them segment-for-segment against the `add_get/add_post/add_put/add_delete`
registrations in `py/routes/*.py` (151 routes), so "the backend is unchanged" is checked
jointly with "the frontend only calls things that exist". The gate is armed inside the test
(a flipped method, a typo, and a wrong suffix after an interpolation all have to go red).

| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | workflow JSON → parameter form | ok | live — 2 workflows × 44 node sections / 94 fields, 58 of them server-constrained (§5.1) |
| 2 | UI↔API conversion reused unchanged | ok | A1, plus `core/workflow.js` being a bare `export { comfyWorkflow }` — there is no re-implementation to drift |
| 3 | `/prompt` + WS progress 0→100% | mechanism ok, pixels not | unit — 9 tests drive **upstream's** `comfyUI.generate()` against a scripted `/prompt` + `/history` and a fake `WebSocket`: the POST body (`client_id`, and the executed workflow under `extra_pnginfo`), the seed stamped in place into `seed` **and** `noise_seed`, `value/max` reaching `onProgress` with another prompt's messages filtered out, and all four ways a run ends badly (`execution_error` → the server's own message, `execution_interrupted` → "Execution interrupted", socket close → "WebSocket disconnected", the `timeoutMs` safety valve). Falsified by pointing the history stub at a mismatched id: 5 of those tests fail with "No history found", so the fetch path is genuinely exercised. What stays unobserved is a real queue item producing pixels (GPU) |
| 4 | storyboard → LoRA auto-inject | ok | unit — active-only payload, `POST /api/wfm/lora/apply` body `{workflow, loras}`, `auto_turbo` key mapping, blank text clears without a request, chip mutations (7 tests) |
| 5 | Style application | ok | unit — `{prompt}` substitution vs append, enabled flag, batch override, unknown name no-op (7 tests) |
| 6 | Wildcard expansion | ok | unit — pinned RNG, comments and blank lines, unknown token verbatim, recursion, Impact nodes skipped, no-token identity (7 tests) |
| 7 | Gen presets store / load / apply | list + apply ok; save implemented, live-blocked | unit — the four routes and their verbatim bodies (3 tests) plus 3 tests for `core/presets.js`, whose record shape is checked against the service itself (top-level keys ⊆ the shipped `_DEFAULT_GEN_PRESETS` keys, stage fields ⊆ what `settings.get(...)` reads). live — applying `⚡ Anima 单采样极速 (Turbo 12步)` to a loaded workflow reported `steps=30 cfg=4 er_sde → steps=12 cfg=1.6 euler_ancestral`. The "save current setup" dialog now exists and was driven in the browser: it opened with all 7 fields, the typed values reached React state (`Preset name="gate probe preset"`, `Steps="17"`, `CFG="3.3"`…), and the `POST /api/wfm/gen_presets` fired — and came back **403**, because the user's long-running `:8000` bridge predates the `Origin` rewrite fix in `tools/dev-server.js` (§6). Restarting that process is the user's call, so the round trip is recorded as *waiting on a bridge restart*, not as passed. The diagnosis was made machine-exact: an identical `DELETE /api/wfm/gen_presets/__probe__` with an `Origin` header returns **403 through the old `:8000` process** and **200 `{"status":"ok","deleted":false}` through a bridge started from current code on `:8002`** — same request, same header, only the code differs. (That probe bridge was mine and has since been stopped; the compute box then stopped answering on `:8188`, `:8000` and `:8002` alike, so no write round trip completed in this session. Static hosting is unaffected: `:8000/wfm_static/newui.html` still serves 200.) |
| 8 | Batch traversal | partly | unit — 3 LoRAs ⇒ exactly 3 generations, the workflow is rewritten before each call, skip keys (`batchNoneSelected`, `modelsGenUINoNode`), failure counting, abort, pause/resume, option forwarding, sorted traversal with the last value left applied (8 tests). Comparing output counts against real images needs a GPU run |
| 9 | Results land in Gallery + workflow backfill | partly | unit — the history → `images` / `svgOutputs` extraction (7 client tests) plus 7 `core/image.js` tests: only `type === "output"` gets a metadata POST, the body is `{path, workflow}` with the path built as `<dir>/<subfolder>/<filename>`, a 500 counts as `failed` instead of rejecting, an unknown output directory means zero requests, `applyDefaultCheckpointIfEnabled` touches the three checkpoint-loader spellings and nothing else, `blobToDataUrl` matches the platform base64 encoder on every padding case, and `flattenFolderTree` labels the root. The Gallery list refreshing itself after a run, and clicking a result back into a workflow, still need a real generation (GPU) |
| 10 | Settings persist across restart | ok | live through the UI on a patched bridge: the output-directory field started at `saved: ""`, typing the current path and pressing Save returned "Output directory saved." and the following `GET` reported `saved: D:\…\Library\output`. `SettingsService` writes `data/settings.json` with `json.dump` and re-reads that file on every access (`_load`), so the value the `GET` returned came off disk rather than a memory cache — which is the same read a restart performs. The field was then set back to `""` and verified, so the store is exactly as found |
| 11 | Models subsystem, 18 items | ok for 17 | live — see §5.1. Item 9's batch Civitai fetch and item 18's bulk move-to-subdir were not exercised (both write to the compute box) |
| 12 | `tools/run_typhon_test.py` untouched | ok for "untouched" | A1 — byte-identical to upstream; *running* it needs a GPU |

Rows 3 and 9 are now covered down to the last thing a unit test can reach — the request shape,
the WebSocket bookkeeping and every failure path are asserted against upstream's own client; what
they still lack is one queued run that turns pixels (GPU time on the compute box, which needs the
user's go-ahead), and the same applies to the run-half of 12. Everything else is machine-checked.

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
- **`md-filter-chip` fires no `input` and no `change` — so every chip handler was dead.**
  `frontend/src/md.ts` mapped the chips with the same `{onChange:"change", onInput:"input"}`
  table used by the real form controls, and `@lit/react` happily accepted a binding for an
  event that never exists. `chips/internal/filter-chip.js` declares only `@fires remove` and
  `@fires update-focus`: clicking it mutates the `selected` property and stops there. The
  visible symptom was nothing at all — the chip lit up, the ★/Batch filters, the grid⇄table
  toggle, select-mode and the per-card Batch/Stack toggles silently did nothing, with no
  console error and no type error. Fixed by mapping `onInput` to `click` for that one
  component (the native click has already run the component's own handler by the time it
  reaches the host, so `selected` is current). `md-tabs` has the same shape (it emits
  `change`, not `input`) but its tabs bind `onClick`, so they were never affected.
- **Every browser write through the dev bridge was 403.** ComfyUI validates the `Origin` header
  on mutating requests and answers `403` with an *empty* body when it does not match its own
  host. `tools/dev-server.js` proxied with `changeOrigin: true`, which rewrites `Host` only — so
  a page served from `:8000` posting to a backend on `:8188` had every write rejected: apply
  preset, save workflow, save metadata, save settings. `curl` (no `Origin`) and `GET` both
  worked, which is why it looked like an endpoint bug rather than a header one. The bridge now
  rewrites `Origin` to the target's own origin; proven by sending the *same* POST with the same
  `Origin` header through the unpatched and patched bridges: 403 then 200.
  **The old UI is hit by it too** — loading `/wfm` against the unpatched bridge logs
  `403 (Forbidden) … /wfm/gallery/groups/ensure` three times, i.e. a pre-existing write path in
  upstream code was failing in exactly the same way, which is what confirmed the bridge (not the
  new UI) as the right layer for the fix. Same page also logs `404`s for `/mask_editor/*`,
  `/image_loop/*` and `/image_feeder/presets`; those are optional upstream tabs whose services
  are not registered on this instance, unrelated to this refactor.
- **`convertUiToApi()` was called without `await` in two views.** Upstream's conversion is
  `async` (it fetches `/object_info` to map widgets), so `Generate.tsx` and `Workflow.tsx` were
  storing a *Promise* as the API graph: `analyzeWorkflow(promise)` returned an empty analysis,
  `Object.entries(promise)` yielded no nodes, and the parameter form silently rendered nothing —
  while `setClientGraph()` handed the same Promise to `comfyUI.currentWorkflow`, which would have
  failed the first real generation. Nothing threw, so nothing was red: no console error, no gate
  failure, no type error (`comfyWorkflow` is untyped JS behind a facade). It surfaced only when
  the acceptance run tried to *count the fields of a loaded workflow* — the one check that
  distinguishes "the view mounted" from "the view works". Every other call site in the repo
  (upstream and `core/batch.js`) awaits it.
- **Two rounds of "contrast failures" were my measurement, not the theme.** See §5.1 — shadow-painted
  containers, slotted-text inheritance, and a backgrounded tab freezing `transition: color`. Each one
  produced a confident-looking number (1.31:1 on every filled button; 1.47:1 on the nav icons) that
  dissolved under a direct probe of the same element. The fix was not to trust the aggregate: re-measure
  one element by a second method, then arm the audit by forcing a colour that *must* fail.

- **A whole accessibility pass was measured against a dead backend.** The first axe sweep
  (7 routes) and a 12-combination contrast re-audit both came back "0 violations / 276 samples,
  worst 5.81:1" and looked like a pass. They were only half real: the SSH tunnel to the compute
  box dropped mid-session, so every view rendered its empty shell (`502` on `/object_info`,
  `/api/wfm/workflows`, `/api/wfm/models/*`) and the "loaded workflow" route scanned a form that
  had never loaded. Nothing in the tools complained. Detection came from the one place that does
  not lie — counting console `502`s — and `netstat` on the box, which showed ComfyUI still
  `LISTENING` while nothing local was forwarding. Both sweeps were re-run behind an explicit
  liveness gate that fails the run unless `/api/wfm/workflows` and `/object_info` answer with
  plausible counts (63 workflows / 3218 classes on this instance). Lesson, again: a green number
  from an empty page is the cheapest green there is, so measure the *data* the page holds, not
  just the absence of errors.
- **Three separate traps in "just add `aria-hidden` / look at the contrast of a disabled field".**
  (a) `aria-hidden` passed to `md-outlined-text-field` never reaches the element: the component
  mirrors it to `data-aria-hidden` for its own notch label, so the attribute the host carries is
  not the one assistive tech reads. (b) Wrapping the field in a real `aria-hidden` span hides the
  *name* but not the *text*: `md-outlined-field` renders its floating label with an explicit
  `aria-hidden="false"`, which re-exposes that one span inside a hidden subtree — and if the field
  is only `readOnly` (not `disabled`) its inner `<input>` stays tabbable, which axe then reports as
  `aria-hidden-focus`, a worse bug than the one being fixed. (c) MD3 draws a disabled field's
  caption as `on-surface` at **`…-disabled-label-text-opacity`**, not as a dim colour, so
  overriding `…-disabled-label-text-color` alone changes nothing measurable. The working form is
  `.nu-readout` in `theme.css`, setting both the colour and the opacity for label and value, which
  takes the caption from 3.05:1 to compliant while the outline keeps the "this is not an input"
  signal. The general rule: material-web's look is composed of colour *and* opacity tokens per
  state, so a state's contrast is fixed with the state's own pair, not by hiding the element.
- **`axe` cannot compute a name through a slot, so it reports a real-looking `link-name` false
  positive.** Two `<a class="nu-link">` elements in `Settings.tsx` wrap their label in
  `<MdOutlinedButton>`, which renders it through `<span class="label"><slot></slot></span>` in its
  shadow root. Both anchors carry 23 and 27 characters of `textContent`, are 166×40 and 176×40
  pixels, and announced `passes: 0 / violations: 1` when the rule was run against the element
  alone. `aria-label` on the anchor (same string as the visible label, so WCAG 2.5.3's
  label-in-name still holds) makes it deterministic in both directions: AT reads it whether or not
  it flattens slots, and the scanner agrees.
- **The user's `:8000` bridge is still running pre-fix code, so browser writes 403 there.**
  Driving the new save-preset dialog end to end produced exactly the symptom recorded above:
  the dialog opened, every field carried its typed value into React state, the
  `POST /api/wfm/gen_presets` really fired, and the console answered `403 Forbidden` — the
  `Origin` check ComfyUI applies to non-GET requests, which `tools/dev-server.js` now rewrites
  but which the long-lived process (started before that commit) cannot pick up without a
  restart. Reads are unaffected, which is why 27 `GET /api/wfm/gen_presets` calls in the same
  minute all returned 200 and the failure looked like the dialog not saving. Not fixed by me:
  restarting someone else's dev process is their call. Any write-path verification must
  therefore happen either after that restart or on a bridge started from current code.
- **Two console warnings the dialog produces, so nobody re-investigates them as ours.** Closing
  an `md-dialog` by clicking its action button logs `Blocked aria-hidden on an element because
  its descendant retained focus` naming `div.focus-trap` — material-web's own trap element, a
  library-side ordering issue, and the browser is protecting focus rather than reporting our bug.
  The open animation logs `Invalid keyframe value for property transform: scale(Infinity)`,
  which reproduces inside @material/web's keyframe computation when the dialog is measured while
  the tab is backgrounded (the same hidden-tab condition that freezes transitions in §5.1's
  measurement notes). Both are `warn`, not `error`; the only `error` in that session was the 403
  above.

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
bash tools/gate-selftest.sh  # proof the gates can still go red
RUN_MERGE_DRY=1 bash tools/check-newui.sh

# Contrast / keyboard audit (browser-side; see MIGRATION-NOTES §5.1):
cp tools/contrast-audit.mjs static/newui/
#   then in the page console:
#   const m = await import("/wfm_static/newui/contrast-audit.mjs")
#   await m.run();  // resolves only after the 12th row; throws if the backend is unreachable
#   m.progress();  m.results();  m.selfTest()

# axe-core (no repo dependency; fetched with `npm pack axe-core --registry=https://registry.npmmirror.com`
# into /tmp, then copied into the gitignored build dir — prove it: `git check-ignore static/newui/axe.min.js`):
cp axe-core/package/axe.min.js static/newui/
#   in the page console:
#   await new Promise((r, j) => { const s = document.createElement('script');
#     s.src = '/wfm_static/newui/axe.min.js'; s.onload = r; s.onerror = j; document.head.appendChild(s); });
#   for (const v of ['workflow','generate','models','prompt','gallery','settings']) {
#     location.hash = '#/' + v; await new Promise(r => setTimeout(r, 9000));
#     console.log(v, (await axe.run(document, { resultTypes: ['violations'] })).violations.map(x => x.id)); }
#   # 9 s is the floor, not a guess: /object_info alone is 16 MB / ~13 s over the tunnel, and a
#   # route scanned before that yields a confident "0 violations" over an empty shell.
```
