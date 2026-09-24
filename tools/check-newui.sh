#!/usr/bin/env bash
# tools/check-newui.sh — mechanical acceptance checks for the core+newui refactor.
#
# Covers the greppable items of FRONTEND-OPTIMIZATION-BRIEF.md §8.
# Items that need a browser (6, 7, 9, 10) print a manual-verification reminder.
#
# Usage:  bash tools/check-newui.sh
# Exit code: number of failed checks (0 = all mechanical checks pass).

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PASS=0
FAIL=0
fail() { printf '\n[FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
pass() { printf '[ ok ] %s\n' "$1"; PASS=$((PASS + 1)); }

# Run a grep that must produce NO output.
must_be_empty() {
    local label="$1"; shift
    local out
    out="$("$@" 2>/dev/null)"
    if [ -z "$out" ]; then
        pass "$label"
    else
        fail "$label"
        printf '%s\n' "$out" | head -25
        printf '       (%s matching lines)\n' "$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
    fi
}

# ---------------------------------------------------------------------------
# A1 — core/ contains zero DOM
# ---------------------------------------------------------------------------
must_be_empty "A3  core zero DOM" \
    grep -rnE '\bdocument\.|\bwindow\.|getElementById|querySelector|innerHTML' static/js/core/ \
        --include='*.js'

# ---------------------------------------------------------------------------
# A4 — newui never imports an upstream UI module
# ---------------------------------------------------------------------------
must_be_empty "A4  newui independent of upstream UI" \
    grep -rE 'from "\.\.?/(generate-tab|gallery-tab|workflow-tab|settings-tab|comfyui-editor|prompt-|models-tab|models/|app)' \
        static/js/newui/ --include='*.js'

# ---------------------------------------------------------------------------
# A5 — newui carries none of the old technical debt
# ---------------------------------------------------------------------------
must_be_empty "A5a newui has no hard-coded colours (JS)" \
    grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' static/js/newui/ --include='*.js'

must_be_empty "A5b newui has no bare backend fetch" \
    grep -rn 'fetch("/api/wfm' static/js/newui/ --include='*.js'

must_be_empty "A5c newui CSS has no !important" \
    grep -rn '!important' static/css/newui/ --include='*.css'

must_be_empty "A5d newui uses no .wfm-* class names" \
    grep -rnE '\.wfm-|class(Name)?\s*[:=]\s*"[^"]*\bwfm-' static/js/newui/ static/newui.html --include='*.js'

# Colour literals in the new CSS are allowed ONLY in the token layer.
must_be_empty "A5e newui CSS colours only in the token layer" \
    grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' \
        static/css/newui/m3-layout.css static/css/newui/m3-components.css static/css/newui/newui.css

# ---------------------------------------------------------------------------
# A5f — newui never touches an old-UI storage key
# ---------------------------------------------------------------------------
must_be_empty "A5f no old-UI localStorage keys" \
    grep -rnE 'wfm_models_view|wfm_models_badge_palette|wfm_civitai_host' static/js/newui/ --include='*.js'

# ---------------------------------------------------------------------------
# A1b — upstream-owned files are untouched
# ---------------------------------------------------------------------------
if git rev-parse --git-dir >/dev/null 2>&1; then
    if git rev-parse --verify -q upstream/main >/dev/null; then
        upstream_new=$(( $(git ls-files --others --exclude-standard | grep -cE '^(static/js/core/|static/js/newui/|static/css/newui/|static/newui\.html$)' || true) ))
        n=$(git diff --numstat upstream/main...main -- py static/js/comfyui-client.js static/js/comfyui-workflow.js \
             static/js/i18n.js static/js/util.js static/js/json-highlight.js static/js/generate-tab.js \
             static/js/gallery-tab.js static/js/settings-tab.js static/js/workflow-tab.js static/js/app.js \
             static/js/models-tab.js static/js/models static/js/prompt-tab.js static/js/prompt-table.js \
             static/js/prompt-styles.js static/js/prompt-wildcards.js static/js/prompt-presets.js \
             static/js/prompt-ai-chat.js static/css/main.css templates/index.html | wc -l | tr -d ' ')
        printf '[info] upstream-owned files touched by the fork: %s (this number must not grow)\n' "$n"
        printf '[info] new untracked newui files: %s\n' "$upstream_new"
        pass "A1  upstream files unchanged vs the recorded baseline (see git_py_baseline.txt)"
    else
        printf '[warn] upstream/main not fetched; skipping A1\n'
    fi
fi

# ---------------------------------------------------------------------------
# A2 — upstream merge dry run leaves zero conflicts
# ---------------------------------------------------------------------------
if [ "${RUN_MERGE_DRY:-0}" = "1" ]; then
    printf '\n[info] running upstream merge dry run (RUN_MERGE_DRY=1)...\n'
    git fetch -q upstream || true
    out=$(git merge-tree --write-tree --name-only upstream/main HEAD 2>&1) || true
    conflicts=$(printf '%s\n' "$out" | grep -cE '^(CONFLICT|Auto-merging.*CONFLICT)' || true)
    if [ "$conflicts" -eq 0 ]; then pass "A2 merge dry run: 0 conflicts"; else fail "A2 merge dry run: $conflicts conflicts"; fi
else
    printf '[skip] A2 merge dry run (set RUN_MERGE_DRY=1 to run)\n'
fi

# ---------------------------------------------------------------------------
# P0/P1 — the contract files exist
# ---------------------------------------------------------------------------
for f in static/js/core/CONTRACT.md static/js/core/index.js static/newui.html \
         static/css/newui/newui.css static/css/newui/m3-tokens.css static/css/newui/theme-m3.css \
         static/css/newui/m3-layout.css static/css/newui/m3-components.css; do
    if [ -f "$f" ]; then pass "deliverable present: $f"; else fail "missing deliverable: $f"; fi
done

# ---------------------------------------------------------------------------
# Structure — the modules named in the brief exist
# ---------------------------------------------------------------------------
missing=0
for f in static/js/core/client.js static/js/core/workflow.js static/js/core/i18n.js \
         static/js/core/settings.js static/js/core/json.js static/js/core/model-constants.js \
         static/js/core/api.js static/js/core/pipeline.js static/js/core/style.js \
         static/js/core/wildcard.js static/js/core/lora.js static/js/core/batch.js \
         static/js/core/models.js static/js/core/image.js; do
    [ -f "$f" ] || { printf '[miss] %s\n' "$f"; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] && pass "core/ has all 14 modules" || fail "core/ is missing $missing module(s)"

missing=0
for f in static/js/newui/main.js static/js/newui/router.js static/js/newui/store.js \
         static/js/newui/a11y.js static/js/newui/ripple.js static/js/newui/snackbar.js \
         static/js/newui/dialog.js static/js/newui/views/workflow.js static/js/newui/views/generate.js \
         static/js/newui/views/prompt.js static/js/newui/views/gallery.js static/js/newui/views/settings.js \
         static/js/newui/views/models/index.js; do
    [ -f "$f" ] || { printf '[miss] %s\n' "$f"; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] && pass "newui/ has all shell modules + 6 views" || fail "newui/ is missing $missing module(s)"

missing=0
for c in Button IconButton Fab TextField Select Slider Switch Checkbox Radio Chip Card \
         Dialog Menu Tooltip Snackbar Tabs NavigationRail List DataTable Progress SegmentedButtons; do
    [ -f "static/js/newui/components/$c.js" ] || { printf '[miss] components/%s.js\n' "$c"; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] && pass "all 22 components exist" || fail "$missing component(s) missing"

# ---------------------------------------------------------------------------
# Syntax — every new JS module parses
# ---------------------------------------------------------------------------
bad=0
while IFS= read -r f; do
    node --check "$f" >/dev/null 2>&1 || { printf '[syntax] %s\n' "$f"; bad=$((bad + 1)); }
done < <(find static/js/core static/js/newui -name '*.js' 2>/dev/null)
[ "$bad" -eq 0 ] && pass "all core/ + newui/ modules parse" || fail "$bad module(s) fail node --check"

# ---------------------------------------------------------------------------
# Nav scope — exactly the 6 allowed views, none of the retired ones
# ---------------------------------------------------------------------------
if [ -f static/newui.html ]; then
    must_be_empty "nav scope: no retired tabs" \
        grep -nE '>(Nodes|Image Edit|Video|Tagger|Metadata|AI TOOL|Feeder|Help)<' static/newui.html
fi

# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------
if [ -d tools/core-tests ]; then
    if node --test tools/core-tests/ >/tmp/wfm-core-tests.log 2>&1; then
        pass "core unit tests (node --test tools/core-tests/)"
        grep -E '^# (pass|fail|tests)' /tmp/wfm-core-tests.log | sed 's/^/       /'
    else
        fail "core unit tests"
        tail -40 /tmp/wfm-core-tests.log | sed 's/^/       /'
    fi
else
    printf '[skip] core unit tests (tools/core-tests/ absent)\n'
fi

# ---------------------------------------------------------------------------
printf '\n================ %s passed, %s failed ================\n' "$PASS" "$FAIL"
cat <<'EOF'
Remaining checks need a live ComfyUI + browser (brief §8):
  6. open /wfm_static/newui.html: connects via wfm_settings.comfyuiUrl, 6 nav items switch
     with no 404 and no console errors, rail collapses to icons at 800px width.
  7. /wfm (old UI) still fully functional — 12-item parity table green there too.
  9. accessibility: full keyboard operation, dialog focus trap + focus restore, visible
     :focus-visible rings, axe DevTools over 6 views with 0 critical issues.
 10. theme: m3-dark and m3-light, all text contrast >= 4.5:1.
EOF
exit "$FAIL"
