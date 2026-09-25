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
   because the old UI at `/wfm` is untouched and still works from a bare clone (§4) — untouched
   apart from `static/js/comfyui-workflow.js`, the one approved deviation (§5.1), which the old UI
   shares and benefits from identically.
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
| `static/js/core/**` — 15 modules, DOM-free, reached only through `core/index.js` | ~3.7k lines; 46 unit tests at handover, **107 now** | **kept whole.** Framework-free by rule B1, which is exactly why it transferred. |
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
3. **Do not edit an upstream-owned file to make a port easier** — that is what breaks the
   zero-conflict property. The only sanctioned reason is an upstream bug worth fixing in place, and
   it costs four things every time: the user's decision, a regression test that goes red without the
   edit, a line in `tools/upstream-deviations.txt`, and a re-recorded baseline
   (`bash tools/gen-upstream-baseline.sh`). One file currently qualifies:
   `static/js/comfyui-workflow.js` (§5.1).
4. `pnpm build` (typecheck + build) and `bash tools/check-newui.sh`, then the merge dry run.
5. Since `static/newui/` is not committed, a port produces a source-only diff: reviewable,
   and it cannot collide with an upstream commit that happens to touch the same area.

### Port ledger

| Date | Upstream range | Upstream files changed | Ported into | Notes |
|---|---|---|---|---|
| — | baseline: no upstream commit merged since the fork point | — | — | open this ledger at the first upstream release after the switch |
| 2026-09-25 | not a merge — a fork-side edit to upstream's file | `static/js/comfyui-workflow.js` (+46/−23) | same file | `convertUiToApi` legacy `widgets_values` normalisation extended to parent-graph nodes (§5.1). Expect a conflict here if upstream touches `_stripLegacyLinkedWidgetValues`, `_simulateWidgetValues` or that loop: keep upstream's loop body, keep the `_withoutLegacyLinkedWidgetEntries` call, then re-run `node --test tools/core-tests/workflow-convert.test.mjs` and `node tools/audit-workflow-conversion.mjs` |

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
| D13 | Models' "Clear" also resets the badge filter, which upstream's Clear button leaves alone. | `models-tab.js:489-517` resets search/tag/dir/group/status and the two chips but never `state.badgeFilter`, so a badge selection survives a button labelled "clear" and the listing looks broken. Cleared here; the deviation is called out in the comment at the call site and in §5.1. |
| D14 | Bulk badge and bulk move ask for confirmation before writing. | Upstream moves or re-badges the whole selection on a single button press (`selection-bulk.js:114-148`). These are the only bulk actions in the app that rename files on the compute box, and a stray click is not cheaply undoable, so they route through `confirmDialog` first. Read-only bulk actions (select-all, clear selection) still act immediately. |

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

#### The presets card has states now — and why it had to

`GenPresetsCard` used to `return null` while its list was empty, which silently swallowed the
whole control (including the save entry point) in three situations: the first paint before
`GET /api/wfm/gen_presets` answered, a failed read, and an actually-empty store. Upstream's
widget does the opposite — `initGenPresetsWidget` renders the bar unconditionally,
`fetchGenPresets` swallows errors into `[]`, and 保存当前 is present regardless — so hiding it was
a fidelity regression I introduced, and it is exactly what produced the "no presets card on a
fresh origin" observation logged in §6 below.

Now: loading renders a labelled `md-linear-progress`; a failed read renders the reason plus a
Retry button; an empty store says so and still offers Save; rows render as before. Verified in
the browser by swapping `window.fetch` for scripted responses and remounting the card between
each case, which is the only way to reach these states while the compute box is down:

| State | Observed in the DOM |
|---|---|
| loading | card present, 1 `md-linear-progress`, Save button present |
| error (scripted 500) | "The preset list could not be read from this server." + a Retry button, Save still present |
| empty (`[]`) | count `0` + "No presets stored yet. Save the current sampler settings to create one." |
| one row | count `1` + that preset's Apply and Delete buttons |

Still open on this change: an axe re-pass over the *new* states. `axe.min.js` could not be
loaded and run at all in this session — the tab is backgrounded, so even the `<script>` `onload`
and `axe.run`'s own scheduling exceed the 15 s per-call budget (three attempts: two load
timeouts, one background runner that never started before its own timeout). The same throttling
is what §5.1's note 3 records for colour transitions, and it is also why no screenshot was
possible. So the rules at stake were measured directly on the live DOM of each state instead:

| State | Direct probe of what axe would have checked |
|---|---|
| loading | one `md-linear-progress`; the host **and** its inner `role="progressbar"` both carry `aria-label="Loading"` → the `aria-progressbar-name` condition holds |
| error | 0 buttons without an accessible name; the retry control reads `Retry` |
| rows | 0 unnamed buttons; the row's controls read `Apply to loaded workflow` and `Delete` |
| empty | the explanatory note renders and the Save entry point is present |

That is a property-level measurement, not axe's verdict, and is not claimed as one. The earlier
7-route/0-violation result covers the bundle before this card change; re-running axe over these
states is owed the next time the tab is in the foreground.

#### Swept the whole React layer for the "hides an entry point" class of bug

The presets bug was not "a card looks bare when empty" but "a control disappears", so every
conditional render in `frontend/src/**/*.tsx` was enumerated (`return null`,
`length === 0 ? null`, and the `? null : null` forms) — four sites in total, each classified
rather than assumed:

| Site | Verdict |
|---|---|
| `App.tsx:35` — `ConnectionDot` while `connected === null` | ok: a status dot with nothing to say yet; it is not a control and appears on the first `/system_stats` answer |
| `Generate.tsx:430` — a node section with zero widget fields | ok, and **not** an un-ported upstream condition: the old UI has no per-node parameter form to copy (`grep` for `render*Param*`, `wfm-param`, `node-param`, `param-section`, `wfm-field` across `static/js/*.js` returns nothing, and neither `generate-tab.js` nor `comfyui-editor.js` contains a widget-skip loop). It is a choice of this UI — a form padded with empty cards is noise — and no entry point disappears, because the node still carries its fields the moment it has any |
| `Settings.tsx:283,294` — rows skipped for `null`/`object` values | ok: those keys have no scalar to edit; the same settings remain reachable through their own fields |
| `GenPresets.tsx` — the whole card | was the bug, now renders in every state (see above) |

#### Models fidelity audit against `static/js/models-tab.js` — every recorded gap is now closed

The 18-item row above was written from the implementation's own reading of the brief. Re-checking
it item by item against the upstream code (with the render-condition question from §6 in mind)
found two real defects and seven fidelity gaps. All of it is now implemented — the two defects in
the earlier session, the gaps on 2026-09-25 — so the row above can be read as "wired, exercised and
line-for-line comparable to upstream", with the single exception stated in the last row below.

Fixed:

- switching model type kept the open detail panel. `loadType()` cleared the selection but not
  `detail`, and the panel's own actions write through the *current* `type` with the *stale*
  `detail.name` (`commitGroups` → `M.saveGroups(type, …)`, `M.setEnabled(type, detail.name, …)`)
  — so choosing LoRA while a checkpoint was open could group or disable a name that does not
  exist in that type. `loadType` now nulls the panel, as upstream's `selectModel`/type switch do.
- the bulk bar was add-only and could not name a new group: it rendered one `+ group…` select over
  `Object.keys(groups)`, so §4 item 5 was unusable until a group existed somewhere else. Upstream
  (`selection-bulk.js`) has a picker plus add **and** remove **and** a free-text
  "create & add". The React bar now has all four, going through `M.withMembers`, which creates the
  key when adding.

Open (evidence, and what it costs the user):

| Gap | Where | Consequence |
|---|---|---|
| ~~Table view has no per-row ★ / enable / Batch-Stack cells~~ **fixed** | `Models.tsx` table body now carries all four, gated by `MC.isBatchType` / `MC.isStackType` exactly as `grid-view.js:149-151,175-186` gates its own columns | items 12/13 are reachable from the table; measured 3 controls per row on checkpoint (B, no S) and 4 on LoRA (B+S), and the VAE header carried neither B nor S |
| ~~Bulk badge cannot *remove*; move cannot create a folder~~ **fixed** | one badge select with Add **and** Remove (`selection-bulk.js:141-148`), move select with `(Root)` = `dest:""` plus a free-text folder and "Create & move" | item 18 reaches a new subdir; `py/services/models_service.py:399-405` rejects separators, so nested paths are still not offered |
| ~~Bulk group *remove* left an empty key behind~~ **fixed** | `pruneEmptyGroups` now drops an emptied group except `MC.RESERVED_GROUPS` (`selection-bulk.js:172-184`, `state.js:10`) — the detail panel's chip-removal goes through it too | |
| ~~No clear-filters and no refresh control~~ **fixed** | toolbar buttons mirroring `models-tab.js:489-517` and `:539-544` | filters are undoable in one click; a stale listing no longer needs a page reload, and a refresh keeps the open detail (verified: card still present 3.5 s after the reload click) |
| ~~No empty-state placeholder~~ **fixed** | `.nu-placeholder` "No models found", rendered before the view branch exactly like `grid-view.js:39-42`, so both views and both causes ("type is empty", "nothing matches") get it | measured: searching `zzz-none` yielded 0 rows + the placeholder; Clear restored the rows and emptied the field |
| ~~Apply-to-Generate is positive-only; Civitai row shows only the sha, `M.civitaiUrl` unused; thumbnail has no Civitai-image fallback~~ **partly fixed** | negative button added behind `type === "embedding"`, gated as `detail-panel.js:255-263` gates it; `civitaiHref` uses `M.civitaiUrl` and renders **no** link when it returns null (upstream falls back to `"#"`); `Thumb` takes `fallbackSrc` = `civitai.images[0]`, upstream's order (`helpers.js:33-57`) | **the embedding half cannot be observed on this box**: `GET /api/wfm/models/files?type=embedding` returns `[]` (zero embedding files), so the negative button's *effect* on the Generate negative field is reviewed at `Generate.tsx:185-193` but not measured. The dead-link check did run: 0 `a[href="#"]` in the panel |

Two deliberate deviations from upstream, both in the new code and both chosen on purpose:
`clearFilters` also resets `badgeFilter`, which upstream's Clear button claims to clear but leaves
alone; and the bulk move/badge writes ask through `confirmDialog` first (upstream moves a whole
selection on a single button press).

Verified in the browser on 2026-09-25 against the rebuilt bundle, with **no write reaching the
box**: the runner replaced `window.fetch` for the duration of the click tests, so the two
state-changing paths were asserted by their *outgoing request* rather than by their side effects.
The table row's own control titles came out as `["Favorite", "Disable", "Batch"]`, and the captured
bodies were

```
POST /api/wfm/models/metadata  {"modelName":"zukiAnimeILL_best.safetensors","favorite":true}
POST /api/wfm/models/groups    {"model_type":"checkpoint","groups":{"Batch":["zukiAnimeILL_best.safetensors"]}}
```

— i.e. the ★ cell really calls `M.saveMetadata` and the B cell really calls the group save with the
model added. The stub was removed afterwards and `GET /api/wfm/models/metadata` still compares
byte-identical to the snapshot taken before any of it (`cmp`, 42 bytes), so the box is as found.

Trap worth recording: the first verification pass after `pnpm build` measured the **previous**
bundle. `location.reload()` of the entry restored it from bfcache, so the page ran the old chunk
graph (`Models-BSmloO0n.js` 404 in the console, app root empty) and could have been read as "the
new controls are missing". A cache-bypassing navigation (`?v=<ts>`) is what makes a post-build
browser check mean what it says.

Also a rule-B1 nit rather than a bug: `Models.tsx:292-293` recomputes group membership inline
where `M.groupsOf` exists, and `M.withTag`/`renameGroup`/`withoutGroup`/`isEnabled` are still
unreached from the view.

#### The compute box became unreachable mid-verification, and what that does and does not explain



`ssh -L 8188:…` was listening locally and `netstat` on the box still showed ComfyUI `LISTENING`
on PID 23176, yet `GET http://127.0.0.1:8188/system_stats` hung for its whole 12 s timeout and
the same request through `:8000` and `:8002` hung too. Static hosting was unaffected
(`:8000/wfm_static/newui.html` → 200), so this is the box or the tunnel's data channel, not the
frontend and not the bridge. Consequences, stated plainly: no write round trip could be
completed after that point, and any "the card shows loading" observation in the table above is
partly a product of it. Nothing on the box was restarted, interrupted, or probed with a
state-changing request.

One stray process of mine was still running at that point: the reverse-forward tunnel (pid 71683),
superseded since by the auto-restarting tunnel loop (bash 22243 → ssh 22245, still up). The
`:8002` probe bridge was stopped (`/bin/kill 86927`, port confirmed closed) and started again later
to close parity row 7 — see the next-but-one section for the current process list.

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

#### The link came back up after a ComfyUI restart — what was re-measured, and one upstream defect it exposed

The box was restarted by the user, so every box-gated claim below was re-taken rather than
carried over. Reads, all through the `:8002` bridge started from current code:

| Probe | Value |
|---|---|
| `GET :8188/system_stats` | 200 (it was a hang before the restart) |
| `GET :8188/queue` | `{"queue_running": [], "queue_pending": []}` — nothing was interrupted |
| `GET /api/wfm/workflows` | 63 workflows |
| `GET /api/object_info` | 3218 classes, 16 973 206 bytes, 32 s over the tunnel |
| cold UI→API convert of `animanga-liino-clean.json` in the browser | 15 nodes, **73 s**, then 34 form fields |

That last row is a UX fact worth keeping: the first workflow load in a fresh page pays the whole
`object_info` fetch, so "the Generate view is slow to show fields" is the tunnel bandwidth, not the
form builder. The §8 note about a 9 s floor for axe routes is the same measurement seen from the
other side.

**My own leftover, cleaned.** The earlier round trip had written one probe record into the user's
`gen_presets.json` (`custom-1770000000001`, "round trip probe") and the box had been unreachable
before it could be deleted. It is now gone: `DELETE /api/wfm/gen_presets/custom-1770000000001` →
`{"status":"ok","deleted":true}`, store 6 → 5. The sixth entry, `illus-zuki-native` ("🌟 光辉
Illustrious 原生"), is *not* mine and was left untouched.

**Parity row 7 closed end-to-end** (see the ledger below): save through the dialog → list re-read
→ apply moves the live graph → delete through the confirm dialog, and `curl` of the store before
and after compares **byte-identical** (`cmp`, 6344 bytes).

**One thing that round trip made visible.** The apply readout printed
`denoise=dpmpp_2m_sde_gpu`, which looks like our code writing a sampler name into a denoise field.
It isn't — it is what the converted API graph actually contains, so `samplerSnapshot` was changed
to print a linked input as `link(929:3)` instead of `String(["929",3])`: the old formatting hid
that applying a preset overwrites two wires with literals, and made a real defect look like a
typo. Verified after the change:

```
⚡ Anima 单采样极速 (Turbo 12步): steps=12 cfg=1.6 sampler_name=link(929:3) scheduler=link(929:4)
  denoise=dpmpp_2m_sde_gpu cfg=8  →  steps=12 cfg=1.6 sampler_name=euler_ancestral
  scheduler=beta57 denoise=dpmpp_2m_sde_gpu cfg=8
```

**The defect itself, pinned (upstream, inherited by both UIs).** `FLS_SamplerV4` node 724 in
`animanga-liino-clean.json` stores `widgets_values =
[706020072129535, "randomize", 12, 1.6, "dpmpp_2m_sde_gpu", "simple", 1, 3, 0.5, 0.85]` while its
`sampler_name`/`scheduler` are wired from node 929 (`KSampler Config (rgthree)`). Upstream's
widget-mapping loop (`static/js/comfyui-workflow.js:727-738`) `continue`s without advancing
`wIdx` for a linked widget that owns a UI slot, on the assumption that a linked widget leaves no
entry in `widgets_values`. This file keeps the stale combo values anyway, so every widget after
the wired pair shifts by two slots. The result of the real conversion, all four surviving entries
wrong:

| Input | object_info type | Converted value | Correct value |
|---|---|---|---|
| `denoise` | `FLOAT` (0–1) | `"dpmpp_2m_sde_gpu"` | `1` |
| `fovea_strength` | `FLOAT` | `"simple"` | `3` |
| `sharpness` | `FLOAT` | `1` | `0.5` |
| `mask_inertia` | `FLOAT` | `3` | `0.85` |

The rescue that would have caught a string in a numeric slot is
`_isExtraWidgetValue` (`:192-200`), which only skips tokens in `_CONTROL_AFTER_GENERATE`
("fixed"/"randomize"/…), so the mismatch is written out verbatim. Both UIs inherited it:
`core/workflow.js` is a bare `export { comfyWorkflow }`, so the defect lived in
`comfyui-workflow.js` itself — which is exactly where it is now fixed.

**Fixed here, by the user's decision, in the upstream file (2026-09-25).** Upstream already solves
this for subgraph-template nodes: `_stripLegacyLinkedWidgetValues` detects the "legacy full"
`widgets_values` convention (a widget that was converted to an input still carries its pre-wiring
value) and drops those entries before mapping. The parent-graph loop had no such call. The fix
extracts that detection into `_withoutLegacyLinkedWidgetEntries()` and calls it from the parent-graph
loop too — no logic duplicated, and the subgraph call site now delegates to the same function.
+46/−23 lines in one file, of which the added block is the moved function.

What pins it, in order of strength:

| Check | Result |
|---|---|
| `tools/core-tests/workflow-convert.test.mjs`, 5 tests on a `FLS_SamplerV4`-shaped fixture | 2 of them red before the fix (`denoise` = `"dpmpp_2m_sde_gpu"`; and with only one combo wired, `scheduler` silently became `"normal"`, the *first* choice in its option list — the COMBO fallback at `:773+` inventing a value), 5/5 green after |
| The real `animanga-liino-clean.json` node 724, converted in Node against the box's own `/object_info` (3218 classes) | before: `denoise:"dpmpp_2m_sde_gpu"`, `fovea_strength:"simple"`, `sharpness:1`, `mask_inertia:3`; after: `1`, `3`, `0.5`, `0.85`, with both wires kept as links |
| `node tools/audit-workflow-conversion.mjs --object-info … --workflows ./workflows` (upstream copy from `upstream/main` vs the working tree, 16 sample workflows) | 0 violations either way, no diff → nothing else changed behaviour |
| Same tool against the user's workflow | `violationsUpstream: 2 → violationsFork: 0`, `repaired: [724.denoise, 724.fovea_strength]`, `introduced: []` |

This is the first and only intentional edit to an upstream-owned file, so the invariant §2 and §5
used to state — "no upstream file was modified" — no longer holds verbatim. It is now expressed as
*A1 pins every upstream-owned file to a recorded hash, with the exceptions listed in
`tools/upstream-deviations.txt`*, and the gate prints `1 approved fork edit(s)`. Finding that
list also turned up a real hole in A1: a *newly tracked* upstream-owned file was never compared
against anything, because the baseline is a list of what existed when it was generated —
`pnpm-workspace.yaml` (added by `bc61253`) and `docs/BATCH-DISPATCH.md` (added by `b9ce815`) had
gone unchecked. A1 now fails on that too, and the ownership pattern moved into
`tools/upstream-owned.pattern` so the generator and the gate cannot disagree about which files the
refactor owns. Both new branches were armed by temporarily deleting the pinned entry and appending
one line to the file; each went red, and both files were then restored byte-identically (`cmp`).

**Merging a future upstream change to this file is now a known conflict point.** Take upstream's
version of the loop, keep the `_withoutLegacyLinkedWidgetEntries` call, re-run
`node --test tools/core-tests/workflow-convert.test.mjs` and then the audit tool — the test fails
loudly if the call was dropped, and the audit names any workflow whose conversion regressed.



### 5.2 Parity ledger — brief §6's 12 rows

"unit" = asserted by `node --test tools/core-tests/` (107 tests); "live" = observed in the
browser against the built bundle; "A1" = the upstream-hash baseline gate proving the named
upstream file still matches the hash recorded in `tools/upstream-baseline.txt` — byte-identity to
*upstream* holds for every such file except the ones listed in `tools/upstream-deviations.txt`
(today: one, `static/js/comfyui-workflow.js`, see §5.1). Two of those tests are a **cross-language route gate**: they
parse every `request()` path/method out of `core/api.js` (93 call sites, 9 of them templated)
and match them segment-for-segment against the `add_get/add_post/add_put/add_delete`
registrations in `py/routes/*.py` (151 routes), so "the backend is unchanged" is checked
jointly with "the frontend only calls things that exist". The gate is armed inside the test
(a flipped method, a typo, and a wrong suffix after an interpolation all have to go red).

| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | workflow JSON → parameter form | ok | live — 2 workflows × 44 node sections / 94 fields, 58 of them server-constrained (§5.1) |
| 2 | UI↔API conversion reused unchanged | ok, with one approved edit | A1 pins the file's hash, and `core/workflow.js` is still a bare `export { comfyWorkflow }` — there is no re-implementation to drift. The one intentional change is the parent-graph half of the legacy `widgets_values` normalisation (§5.1), covered by 5 tests in `tools/core-tests/workflow-convert.test.mjs` and measurable against upstream with `node tools/audit-workflow-conversion.mjs` |
| 3 | `/prompt` + WS progress 0→100% | mechanism ok, pixels not | unit — 9 tests drive **upstream's** `comfyUI.generate()` against a scripted `/prompt` + `/history` and a fake `WebSocket`: the POST body (`client_id`, and the executed workflow under `extra_pnginfo`), the seed stamped in place into `seed` **and** `noise_seed`, `value/max` reaching `onProgress` with another prompt's messages filtered out, and all four ways a run ends badly (`execution_error` → the server's own message, `execution_interrupted` → "Execution interrupted", socket close → "WebSocket disconnected", the `timeoutMs` safety valve). Falsified by pointing the history stub at a mismatched id: 5 of those tests fail with "No history found", so the fetch path is genuinely exercised. What stays unobserved is a real queue item producing pixels (GPU) |
| 4 | storyboard → LoRA auto-inject | ok | unit — active-only payload, `POST /api/wfm/lora/apply` body `{workflow, loras}`, `auto_turbo` key mapping, blank text clears without a request, chip mutations (7 tests) |
| 5 | Style application | ok | unit — `{prompt}` substitution vs append, enabled flag, batch override, unknown name no-op (7 tests) |
| 6 | Wildcard expansion | ok | unit — pinned RNG, comments and blank lines, unknown token verbatim, recursion, Impact nodes skipped, no-token identity (7 tests) |
| 7 | Gen presets store / load / apply | ok | unit — the four routes and their verbatim bodies (3 tests) plus 3 tests for `core/presets.js`, whose record shape is checked against the service itself (top-level keys ⊆ the shipped `_DEFAULT_GEN_PRESETS` keys, stage fields ⊆ what `settings.get(...)` reads). live — **the whole write cycle now closed in the browser, through the card and nothing else**: "Save current setup" opened the dialog with 7 fields, the typed values survived into the stored record (`{steps:13, cfg:1.7, sampler_name:"euler", scheduler:"normal", denoise:0.9}`, `sampling_mode:"single"` — so `numOf`'s empty-string rule and the single-vs-stage key choice are both observed on real bytes, not just in a unit test), the list re-read it, "Apply to loaded workflow" moved the live graph (`steps=12 cfg=1.6 sampler_name=euler_ancestral scheduler=beta57 → steps=13 cfg=1.7 sampler_name=euler scheduler=normal denoise=0.9`), and "Delete" through the confirm dialog took the store back to 5 entries — `curl` of `/api/wfm/gen_presets` before and after compared **byte-identical** (6344 bytes, `cmp` clean). This ran through a bridge started from current code on `:8002`, not the user's `:8000`: the old process predates the `Origin` rewrite in `tools/dev-server.js` and 403s every write (§6), and restarting it is the user's call. The A/B that made that machine-exact: identical `DELETE /api/wfm/gen_presets/__probe__` → **403 on the old `:8000`**, **200 `{"status":"ok","deleted":false}` on `:8002`**. |
| 8 | Batch traversal | partly | unit — 3 LoRAs ⇒ exactly 3 generations, the workflow is rewritten before each call, skip keys (`batchNoneSelected`, `modelsGenUINoNode`), failure counting, abort, pause/resume, option forwarding, sorted traversal with the last value left applied (8 tests). Comparing output counts against real images needs a GPU run |
| 9 | Results land in Gallery + workflow backfill | partly | unit — the history → `images` / `svgOutputs` extraction (7 client tests) plus 7 `core/image.js` tests: only `type === "output"` gets a metadata POST, the body is `{path, workflow}` with the path built as `<dir>/<subfolder>/<filename>`, a 500 counts as `failed` instead of rejecting, an unknown output directory means zero requests, `applyDefaultCheckpointIfEnabled` touches the three checkpoint-loader spellings and nothing else, `blobToDataUrl` matches the platform base64 encoder on every padding case, and `flattenFolderTree` labels the root. The Gallery list refreshing itself after a run, and clicking a result back into a workflow, still need a real generation (GPU) |
| 10 | Settings persist across restart | ok | live through the UI on a patched bridge: the output-directory field started at `saved: ""`, typing the current path and pressing Save returned "Output directory saved." and the following `GET` reported `saved: D:\…\Library\output`. `SettingsService` writes `data/settings.json` with `json.dump` and re-reads that file on every access (`_load`), so the value the `GET` returned came off disk rather than a memory cache — which is the same read a restart performs. The field was then set back to `""` and verified, so the store is exactly as found |
| 11 | Models subsystem, 18 items | ok, with two run-halves unobserved | live — see §5.1, where every recorded fidelity gap is now closed. Two things have still never *executed* on the box: item 9's batch Civitai fetch (it fans out to an external API), and item 18's bulk move — the new-folder control is implemented and routes to `api.moveModels`, but no move request was ever emitted, because the verification stubs only covered the ★ and Batch cells (`POST /models/metadata`, `POST /models/groups` bodies captured in-page; nothing reached the server). The move path is reviewed at `Models.tsx` `bulkMove` + `py/services/models_service.py:390-405` and needs the user's go-ahead to run for real |
| 12 | `tools/run_typhon_test.py` untouched | ok for "untouched" | A1 — byte-identical to upstream; *running* it needs a GPU |

Rows 3 and 9 are now covered down to the last thing a unit test can reach — the request shape,
the WebSocket bookkeeping and every failure path are asserted against upstream's own client; what
they still lack is one queued run that turns pixels (GPU time on the compute box, which needs the
user's go-ahead), and the same applies to the run-half of 12. Everything else is machine-checked.

### 5.3 Handoff — what stands, what is parked, and the exact next move

Captured at the end of the session that produced commits `f637f53 … 9b4f614` (test count 46 →
102), and extended on 2026-09-25 after the compute box came back (test count 102 → 107). Everything
below is reproducible from the repo; nothing depends on this conversation.

Standing state, verified in this state: `node --test tools/core-tests/` → 107/107; `pnpm build`
(tsc + vite) clean; `bash tools/check-newui.sh` → 26/26; gate A1 green, reporting
`1 approved fork edit(s)` — every upstream-owned file matches the hash recorded in
`tools/upstream-baseline.txt` except `static/js/comfyui-workflow.js`, whose intentional change is
named in `tools/upstream-deviations.txt` and pinned at its post-fix hash; `py/` is untouched by the
refactor; `git ls-files static/newui static/newui.html` → 0, so no build output is committed. The
earlier commits were pushed to `origin/main` by the user, and `b9ce815` on top of them is the user's
own work (a batch tool plus `lora_trigger_{routes,service}`) — not mine, and not to be reverted.

Parked, in the order that unblocks the most:

1. Parity rows 3, 9 and the run-half of 12 need one real generation on the compute box, which
   needs the user's go-ahead for GPU time. The box is **not reachable again** as of this session's
   end: on the Windows side `pythonProcs=0` and nothing listens on 8188 (the tunnel itself is up,
   pid 22243/22245, so `:8188` answers immediately with a refused connection rather than hanging —
   a different failure than the earlier "process alive, no socket"). `bash tools/live-verify.sh`
   re-diagnoses in seconds and exits 2 while it is down. The widget-shift blocker that used to sit
   in front of this item is fixed (§5.1), so a run only needs the box started and approved.
2. An axe re-pass over the presets card's new states, the Models table's new cells, and any
   screenshot check. All need the browser tab in the foreground: a backgrounded tab throttles
   timers, freezes transitions and `requestAnimationFrame`, offers no visible surface, and made even
   `axe.min.js`'s `onload` exceed a 15 s call budget here. This session's tab reported
   `visibilityState: "hidden"` too, so the round trip and the Models gaps were verified by DOM
   state, captured requests and store bytes — not by axe or a screenshot.
3. Two Models run-halves that a gate cannot reach, both listed in §5.2 row 11: the batch Civitai
   fetch, and an actual bulk move (including into a brand-new subfolder). Both write to the compute
   box's model library, so they are the user's to run.

Parity row 7 is no longer parked: the save → list → apply → delete cycle completed in the browser
against a bridge running current code, and the preset store was compared byte-identical before and
after (§5.1, §5.2). Neither is the Models fidelity work: every gap §5.1 recorded is closed, with the
write paths proven by intercepted requests instead of side effects. And the upstream conversion
defect is fixed rather than parked — 5 tests plus `tools/audit-workflow-conversion.mjs`, which
measures the fork's conversions against `upstream/main`'s on the same workflows.

Process footprints left behind, all mine and all disposable: the tunnel loop (bash pid 22243
keeping `ssh -N -L 8188:127.0.0.1:8188 win30902`, pid 22245, alive), and my own bridge
`PORT=8002 node tools/dev-server.js` (pid 27386) started to close row 7 — the user's `:8000`
(pid 7112) was left exactly as found and still 403s browser writes until they restart it.
`static/newui/axe.min.js` and `static/newui/contrast-audit.mjs` are gone: this session's
`pnpm build` ran `prebuild`, which deletes `static/newui`; re-copy them from `/tmp` if the axe
re-pass is scheduled.

Explicitly not planned: touching `py/`, deleting an upstream file, or rewriting one beyond the
single approved deviation in `tools/upstream-deviations.txt` — a second one needs the user's
decision, a regression test, and a re-recorded baseline. Also not planned: restarting the
user's bridge or ComfyUI without asking, and mounting the presets card inside Generate (its
`storyLoras` prop exists for exactly that; today it stores sampler settings only, which the card
says out loud).



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
- **Gate A1 could not see additions.** It iterates the baseline's own entries, so a *newly tracked*
  upstream-owned file was never compared against anything — silently outside the gate. Two had
  accumulated: `pnpm-workspace.yaml` (added by this refactor's own `bc61253`) and
  `docs/BATCH-DISPATCH.md` (added by the user's `b9ce815`). A1 now also fails on
  "upstream-owned files NOT IN BASELINE", the ownership pattern moved to
  `tools/upstream-owned.pattern` so the generator and the gate share one definition, and both
  branches were armed by hand (delete a pinned entry → red; append one line to the pinned file →
  red) and reverted with `cmp` confirming byte-identical restore. A hash list is only as good as the
  `git ls-files` set it was derived from; regenerating it is now a step any added file forces.
- **A cosmetic readout line was worth following.** The presets card printed
  `denoise=dpmpp_2m_sde_gpu`, which looked like a formatting bug in the new UI and was tempting to
  tidy silently. Printing linked inputs as `link(929:3)` instead of `String(["929",3])` is what
  proved the value was really in the graph, which led to the `convertUiToApi` slot-shift defect in
  upstream code that both UIs were sending to `/prompt` (§5.1). Lesson: when a display value is
  surprising, first make the display *exact*, then decide whether the surprise is in the data.
- **A post-build browser check measured the previous bundle.** After `pnpm build`, `location.reload()`
  on the entry restored the old page from bfcache: the console 404'd a chunk name that no longer
  existed and `#nu-root` stayed empty. Read as "the controls I just wrote are missing", it was one
  interpretation away of being written off as a broken build; the first Models verification pass ran
  entirely against stale code before the empty console told. Fix: navigate with a cache-busting
  query (`?v=<ts>`), and treat "0 elements found" as an unknown until the loaded bundle hash is
  checked against the build output.

---

## 7. Rollback

The old UI is untouched and remains the default entry at `/wfm`
(`templates/index.html:3475` → `/wfm_static/js/app.js`). The new UI is *additional*:
`static/newui.html` plus a generated asset folder. Rolling back = stop visiting that URL;
no data migration is involved, and no old-UI file, route or storage key was repurposed.
Keep `/wfm` for at least two weeks after switching (brief §9 P6).

One thing rollback does **not** undo: the conversion fix in `static/js/comfyui-workflow.js`
(`tools/upstream-deviations.txt`), because both UIs load that module. If the new UI is abandoned and
the old one kept, that edit is still an improvement to keep — reverting it means
`animanga-liino-clean.json` and anything else saved in the legacy `widgets_values` style goes back to
sending a string where `denoise` is a FLOAT. To revert deliberately: `git show upstream/main:static/js/comfyui-workflow.js`,
drop the line from `tools/upstream-deviations.txt`, re-run `bash tools/gen-upstream-baseline.sh`, and
expect `tools/core-tests/workflow-convert.test.mjs` to go red — that file is the tripwire.

---

## 8. Commands

```bash
pnpm install                 # deps (pnpm is the package manager; packageManager field pins it)
pnpm build                   # tsc --noEmit && vite build   (use this, not `pnpm exec vite build`)
pnpm build:watch             # rebuild into static/ on change
pnpm dev                     # serve static/ + reverse-proxy ComfyUI (default http://127.0.0.1:8188)
                             # then open http://localhost:8000/wfm_static/newui.html
pnpm test:core               # node --test tools/core-tests/
bash tools/check-newui.sh    # every mechanical gate (A1 prints "1 approved fork edit(s)")
bash tools/gate-selftest.sh  # proof the gates can still go red
bash tools/live-verify.sh    # read-only link ladder + the exact commands for what gates cannot
                             #   reach (browser sweeps, the GPU rows, the Civitai/move writes);
                             #   exits 2 when the compute box is unreachable, 0 when a sweep is
                             #   meaningful. It performs no writes and starts nothing.
node tools/audit-workflow-conversion.mjs             # upstream's convertUiToApi vs the fork's, over
                             #   every saved workflow; exits 1 if the fork introduced a violation.
                             #   Needs the box, or --object-info <file> --workflows <dir> to run offline.
RUN_MERGE_DRY=1 bash tools/check-newui.sh

# After `pnpm build`, open the entry with a cache-busting query (?v=<ts>). A plain reload can restore
# the previous bundle from bfcache, and the page then measures code you already replaced — see §6.

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
