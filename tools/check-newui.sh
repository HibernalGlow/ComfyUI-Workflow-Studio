#!/usr/bin/env bash
# tools/check-newui.sh — mechanical acceptance gates for the core + newui refactor.
#
# Route v2: the UI is React + @material/web, written in TypeScript under frontend/src,
# built by Vite into static/ (gitignored). The framework-free logic layer stays in
# static/js/core/** and is reached only through static/js/core/index.js.
#
# Every grep gate fails LOUDLY when its target tree is missing: a grep over an empty
# directory is not evidence, so each one is preceded by a `probe` that must succeed.
#
# Usage:  bash tools/check-newui.sh
#         RUN_MERGE_DRY=1 bash tools/check-newui.sh   # + upstream merge dry run
# Exit status: number of failed gates.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PASS=0
FAIL=0
fail() { printf '\n[FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
pass() { printf '[ ok ] %s\n' "$1"; PASS=$((PASS + 1)); }

if ! command -v rg >/dev/null 2>&1; then
    echo "rg (ripgrep) is required — these gates are written against rg, not GNU grep." >&2
    exit 1
fi

# must_be_empty LABEL PROBE rg-args...
must_be_empty() {
    local label="$1" probe="$2"; shift 2
    if ! eval "$probe" >/dev/null 2>&1; then
        fail "$label — probe failed, source tree missing"
        return
    fi
    local out
    out="$("$@" 2>/dev/null)"
    if [ -z "$out" ]; then
        pass "$label"
    else
        fail "$label"
        printf '%s\n' "$out" | head -20
        printf '       (%s matching lines)\n' "$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
    fi
}

SRC=frontend/src
GATES_PROBE="ls $SRC/main.tsx"

# ---------------------------------------------------------------------------
# 0. the trees these gates describe must exist
# ---------------------------------------------------------------------------
for p in static/js/core "$SRC" static/css/newui/m3-tokens.css static/css/newui/theme-m3.css; do
    if [ -e "$p" ]; then pass "required path: $p"; else fail "required path missing: $p"; fi
done

if [ -d static/js/newui ]; then
    fail "static/js/newui still ships — the discarded hand-written layer must not be served"
else
    pass "hand-written component layer is out of the served tree"
fi

# ---------------------------------------------------------------------------
# A3 — core/ is DOM-free (the seam the whole refactor rests on)
# ---------------------------------------------------------------------------
must_be_empty "A3  core zero DOM" \
    "ls static/js/core/index.js" \
    rg -n --glob '*.js' '\bdocument\.|\bwindow\.|getElementById|querySelector|innerHTML' static/js/core

# ---------------------------------------------------------------------------
# A4 — the React layer reaches logic only through core/index.js
# ---------------------------------------------------------------------------
must_be_empty "A4a React layer imports no upstream UI module" "$GATES_PROBE" \
    rg -n "$SRC" -e 'from "\.\.?/(generate-tab|gallery-tab|workflow-tab|settings-tab|comfyui-editor|prompt-|models-tab|models/|app)'

must_be_empty "A4b React layer never deep-imports a core module" "$GATES_PROBE" \
    rg -n --pcre2 "$SRC" -e 'from "[^"]*core/(?!index\.js)'

must_be_empty "A4c no bare import of an upstream static/js module" "$GATES_PROBE" \
    rg -n "$SRC" -e 'from "\.\./\.\./(util|i18n|comfyui-client|comfyui-workflow|json-highlight)\.js"'

must_be_empty "A4d views reach core through the alias, not a relative path" "$GATES_PROBE" \
    rg -n "$SRC/views" -e 'from "\.\./\.\./core'

# ---------------------------------------------------------------------------
# A5 — none of the old technical debt is repeated
# ---------------------------------------------------------------------------
must_be_empty "A5a no colour literals in the TS source" "$GATES_PROBE" \
    rg -n -g '*.ts' -g '*.tsx' "$SRC" -e '#[0-9a-fA-F]{3,8}\b|rgba?\('

must_be_empty "A5b no bare backend fetch" "$GATES_PROBE" \
    rg -n -g '*.ts' -g '*.tsx' "$SRC" -e 'fetch\((["'"'"'`])/api/wfm'

must_be_empty "A5c no .wfm-* class names" "$GATES_PROBE" \
    rg -n -g '*.ts' -g '*.tsx' -g '*.css' "$SRC" -e '\bwfm-'

must_be_empty "A5d no old-UI localStorage keys in the React layer" "$GATES_PROBE" \
    rg -n -g '*.ts' -g '*.tsx' "$SRC" -e 'wfm_models_view|wfm_models_badge_palette|wfm_civitai_host|wfm_views'

# !important is tolerated only in the prefers-reduced-motion override, which has to
# beat transitions declared elsewhere.
if [ -f "$SRC/theme.css" ]; then
    rm_line=$(rg -n 'prefers-reduced-motion' "$SRC/theme.css" | head -1 | cut -d: -f1)
    imp_lines=$(rg -n '!important' "$SRC/theme.css" | cut -d: -f1)
    imp_bad=0
    for n in $imp_lines; do
        if [ -n "${rm_line:-}" ] && [ "$n" -gt "$rm_line" ]; then continue; fi
        imp_bad=$((imp_bad + 1))
    done
    if [ -z "$imp_lines" ]; then
        pass "A5e no !important anywhere in the app CSS"
    elif [ "$imp_bad" -eq 0 ]; then
        pass "A5e !important confined to the prefers-reduced-motion block"
    else
        fail "A5e !important outside the reduced-motion override ($imp_bad occurrence(s))"
        rg -n '!important' "$SRC/theme.css" | head -10
    fi
else
    fail "A5e $SRC/theme.css missing"
fi

must_be_empty "A5f no native blocking dialogs (window.confirm/prompt/alert)" "$GATES_PROBE" \
    rg -n -g '*.ts' -g '*.tsx' "$SRC" -e 'window\.(confirm|prompt|alert)\('

# Upstream `convertUiToApi()` is async (it consults /object_info). Calling it without
# `await` stores a Promise where the API graph belongs: the analysis comes back empty,
# the parameter form renders nothing, and the first real generation would fail — all
# silently, with no type error, because `comfyWorkflow` is untyped JS. See §6.
must_be_empty "A5g no un-awaited convertUiToApi in the React layer" "$GATES_PROBE" \
    sh -c 'rg -n -g "*.tsx" -g "*.ts" frontend/src -e "convertUiToApi\(" | awk "/convertUiToApi/ && !/await/ {print; found=1} END {exit found?0:1}"'

# ---------------------------------------------------------------------------
# T — types and build
# ---------------------------------------------------------------------------
if [ -e node_modules/.bin/tsc ]; then
    if out=$(node_modules/.bin/tsc --noEmit 2>&1); then
        pass "T1  tsc --noEmit clean"
    else
        fail "T1  tsc --noEmit reported errors"
        printf '%s\n' "$out" | head -20
    fi
else
    fail "T1  typescript not installed (run pnpm install) — cannot gate on types"
fi

if [ -f static/newui.html ] && [ -d static/newui ]; then
    assets=$(find static/newui -type f | wc -l | tr -d ' ')
    stale=$(find static/newui -name '*.js' | wc -l | tr -d ' ')
    referenced=$(rg -o 'newui/[A-Za-z0-9._-]+\.(js|css)' -N static/newui.html | sort -u | wc -l | tr -d ' ')
    if [ "$assets" -gt 0 ]; then
        pass "T2  build output: static/newui.html + $assets file(s), $referenced referenced by the entry (js chunks: $stale)"
    else
        fail "T2  static/newui is empty — run pnpm build"
    fi
    if rg -q 'static/newui' .gitignore; then
        pass "T2b built output is gitignored (dist is not committed)"
    else
        fail "T2b built output is NOT gitignored — the route requires dist to stay out of the repo"
    fi
    if rg -q 'static/newui\.html' .gitignore; then
        pass "T2c built entry is gitignored"
    else
        fail "T2c static/newui.html is tracked but generated — add it to .gitignore"
    fi
else
    fail "T2  no build output (static/newui.html / static/newui) — run pnpm build"
fi

# ---------------------------------------------------------------------------
# A1/A2 — upstream-owned files untouched, merge stays conflict-free
# ---------------------------------------------------------------------------
# A1 — every tracked file the refactor does not own must still match its baseline hash.
# This is the machine-checked form of "upstream-owned files are untouched": the earlier
# version only printed a count and always passed, which is not a gate.
BASELINE=tools/upstream-baseline.txt
if [ -f "$BASELINE" ]; then
    changed=""; vanished=""; checked=0; deleted_known=0
    while IFS=$'\t' read -r hash path; do
        case "$hash" in
            \#DELETED*) deleted_known=$((deleted_known + 1)); continue ;;
            \#*) continue ;;
        esac
        [ -z "${hash:-}" ] && continue
        checked=$((checked + 1))
        if [ ! -f "$path" ]; then
            vanished="${vanished}${path}\n"
        elif [ "$(git hash-object "$path")" != "$hash" ]; then
            changed="${changed}${path}\n"
        fi
    done < <(sed 's/# DELETED\t/#DELETED\t/' "$BASELINE")

    printf '[info] A1 checked %d baseline entry(s); %d recorded deletion(s)\n' "$checked" "$deleted_known"
    if [ -z "$changed" ] && [ -z "$vanished" ]; then
        pass "A1  no upstream-owned file was modified or removed"
    else
        [ -n "$changed" ] && { fail "A1  upstream-owned files CHANGED"; printf "$changed" | head -20; }
        [ -n "$vanished" ] && { fail "A1  upstream-owned files MISSING"; printf "$vanished" | head -20; }
        printf '       fix the code, or re-record the baseline deliberately:\n'
        printf '         bash tools/gen-upstream-baseline.sh\n'
    fi
else
    fail "A1  $BASELINE is missing — run bash tools/gen-upstream-baseline.sh"
fi

if git rev-parse --verify -q upstream/main >/dev/null 2>&1; then
    if [ "${RUN_MERGE_DRY:-0}" = "1" ]; then
        git fetch -q upstream || true
        # `merge-tree --write-tree` exits 0 for a clean merge and 1 when it conflicts,
        # printing only the resulting tree OID on success. The exit code is the signal;
        # grepping the output is not (an empty result reads as "0 conflicts" either way).
        if git merge-tree --write-tree --name-only HEAD upstream/main >/tmp/wfm-merge.out 2>&1; then
            pass "A2  merge dry run: clean (0 conflicts)"
        else
            fail "A2  merge dry run reported conflicts"
            rg -n 'CONFLICT|<<<<<<<' /tmp/wfm-merge.out | head -20
        fi
    else
        printf '[skip] A2  merge dry run (set RUN_MERGE_DRY=1)\n'
    fi
else
    printf '[warn] upstream/main unavailable — A2 not measured\n'
fi

# ---------------------------------------------------------------------------
# U — core tests. A green run that asserted nothing is NOT a pass.
# ---------------------------------------------------------------------------
log=/tmp/wfm-core-tests.log
if [ -f tools/core-tests/core.test.mjs ]; then
    if node --test tools/core-tests/ >"$log" 2>&1; then
        passed=$(awk '/ pass /{v=$NF} END{print v+0}' "$log")
        failed=$(awk '/ fail /{v=$NF} END{print v+0}' "$log")
        if [ "${passed:-0}" -ge 40 ] && [ "${failed:-1}" -eq 0 ]; then
            pass "U1  core unit tests: $passed passed, 0 failed"
        else
            fail "U1  core tests did not really run (pass=${passed:-?} fail=${failed:-?})"
            tail -25 "$log"
        fi
    else
        fail "U1  core unit tests failed"
        tail -30 "$log"
    fi
else
    fail "U1  tools/core-tests/core.test.mjs is missing"
fi

if [ -f tools/core-tests/import-check.mjs ]; then
    if node tools/core-tests/import-check.mjs >/tmp/wfm-import-check.log 2>&1; then
        pass "U2  core import + api-symbol integration check"
    else
        fail "U2  core import/integration check"
        tail -20 /tmp/wfm-import-check.log
    fi
else
    fail "U2  tools/core-tests/import-check.mjs is missing"
fi

# Operational files must not point at the discarded tree. MIGRATION-NOTES.md is exempt by
# design: naming the path that was removed is the whole point of the record.
must_be_empty "S1  no stale reference to the discarded static/js/newui tree" \
    "ls tools/check-newui.sh" \
    rg -n --glob '!check-newui.sh' --glob '!MIGRATION-NOTES.md' 'static/js/newui' tools static/js/core static/css frontend/src 2>/dev/null

if [ -f tools/gate-selftest.sh ]; then
    if bash tools/gate-selftest.sh >/tmp/wfm-gate-selftest.log 2>&1; then
        pass "S2  gate self-test: every sampled gate can still go red"
    else
        fail "S2  a gate lost its teeth (self-test failed)"
        tail -20 /tmp/wfm-gate-selftest.log
    fi
else
    fail "S2  tools/gate-selftest.sh is missing"
fi

# ---------------------------------------------------------------------------
printf '\n================ %s passed, %s failed ================\n' "$PASS" "$FAIL"
cat <<'EOF'
Live-browser items (brief §8 6-10) are measured and logged in MIGRATION-NOTES §5.1:
axe-core 0 violations over 7 routes, contrast 635 samples / 12 view×theme rows / 0 failures,
keyboard reach, console clean, old-UI rollback, Models' 18 items, and the rail collapse
measured at a 319px viewport (its cascade rule is a unit test; the >839px state was not
re-measured in that session, and §5.1 says so).
What no mechanical gate can close: parity rows 3, 9 and the run-half of 12 — a real generation
queued on the compute box, which needs the user's go-ahead (MIGRATION-NOTES §5.2).
EOF
exit "$FAIL"
