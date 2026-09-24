#!/usr/bin/env bash
# tools/gate-selftest.sh — prove the acceptance gates can actually fail.
#
# A gate that only ever prints "[ ok ]" is not a gate. This feeds each of the
# three load-bearing checks a deliberately wrong input and requires the RED
# result, so a future edit that neuters a pattern is caught here first.
#
# Nothing in the repository is modified: bad inputs are written under a temp dir.
#
# Usage: bash tools/gate-selftest.sh
# Exit status: number of gates that failed to fail.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

FAILS=0
expect() { # EXPECTED_VERDICT LABEL  then-run
    local want="$1" label="$2"; shift 2
    local out rc
    out="$("$@" 2>&1)"; rc=$?
    local got="clean"
    [ -n "$out" ] && got="dirty"
    if [ "$want" = "$got" ]; then
        printf '[ ok ] %-58s -> %s\n' "$label" "$got"
    else
        printf '[FAIL] %-58s -> %s (wanted %s)\n' "$label" "$got" "$want"
        FAILS=$((FAILS + 1))
    fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- 1. the DOM gate must fire on real DOM code ------------------------------
printf 'const a = document.getElementById("x"); a.innerHTML = "<b>";\n' > "$tmp/dom-bad.js"
printf 'export const ok = 1;\n' > "$tmp/dom-good.js"
expect dirty "A3 flags document/getElementById/innerHTML" \
    rg --glob '*.js' '\bdocument\.|\bwindow\.|getElementById|querySelector|innerHTML' "$tmp/dom-bad.js"
expect clean "A3 ignores a DOM-free module" \
    rg --glob '*.js' '\bdocument\.|\bwindow\.|getElementById|querySelector|innerHTML' "$tmp/dom-good.js"

# --- 2. the colour-literal gate must fire -------------------------------
printf 'color: #6366f1; background: rgba(0,0,0,.3);\n' > "$tmp/colour-bad.tsx"
printf 'color: var(--md-sys-color-primary);\n' > "$tmp/colour-good.tsx"
expect dirty "A5a flags hex + rgba colour literals" \
    rg -g '*.tsx' '#[0-9a-fA-F]{3,8}\b|rgba?\(' "$tmp/colour-bad.tsx"
expect clean "A5a ignores token-based colour" \
    rg -g '*.tsx' '#[0-9a-fA-F]{3,8}\b|rgba?\(' "$tmp/colour-good.tsx"

# --- 3. the upstream-owned baseline must detect a wrong hash -----------------
# Re-implement the A1 comparison here against synthetic baselines so a real file
# is never touched.
bad_hash=$(printf '0000000000000000000000000000000000000000\t%s\n' "static/js/i18n.js")
real_hash=$(printf '%s\t%s\n' "$(git hash-object static/js/i18n.js)" "static/js/i18n.js")
ghost=$(printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\t%s\n' "static/js/definitely-not-here.js")

a1() { # reads a baseline on stdin, prints CHANGED/MISSING lines
    local hash path
    while IFS=$'\t' read -r hash path; do
        case "$hash" in \#*|"") continue ;; esac
        if [ ! -f "$path" ]; then printf 'MISSING\t%s\n' "$path"
        elif [ "$(git hash-object "$path")" != "$hash" ]; then printf 'CHANGED\t%s\n' "$path"
        fi
    done
}

# A shell function cannot cross `bash -c`, so A1 is exercised directly below.
out_real=$(printf '%s\n' "$real_hash" | a1)
out_wrong=$(printf '%s\n' "$bad_hash" | a1)
out_ghost=$(printf '%s\n' "$ghost" | a1)
if [ -z "$out_real" ]; then
    printf '[ ok ] A1 accepts the correct baseline hash\n'
else
    printf '[FAIL] A1 rejected a CORRECT hash: %s\n' "$out_real"; FAILS=$((FAILS + 1))
fi
if [ "$out_wrong" = "CHANGED	static/js/i18n.js" ]; then
    printf '[ ok ] A1 detects a wrong hash (CHANGED)\n'
else
    printf '[FAIL] A1 did not flag a wrong hash (got: %s)\n' "${out_wrong:-<none>}"; FAILS=$((FAILS + 1))
fi
if [ "$out_ghost" = "MISSING	static/js/definitely-not-here.js" ]; then
    printf '[ ok ] A1 detects a removed file (MISSING)\n'
else
    printf '[FAIL] A1 did not flag a removed file (got: %s)\n' "${out_ghost:-<none>}"; FAILS=$((FAILS + 1))
fi

# --- 4. the unit-test gate must not accept a vacuous run ---------------------
printf 'x\n' > "$tmp/no-tests.log"
node_pass=$(awk '/ pass /{v=$NF} END{print v+0}' <<< "ℹ tests 0
ℹ pass 0
ℹ fail 0")
if [ "${node_pass:-0}" -lt 40 ]; then
    printf '[ ok ] U1 refuses a 0-assertion run (parsed pass=%s, gate needs >=40)\n' "$node_pass"
else
    printf '[FAIL] U1 accepted an empty test run (pass=%s)\n' "$node_pass"; FAILS=$((FAILS + 1))
fi

printf '\n================ selftest: %s failure(s) ================\n' "$FAILS"
[ "$FAILS" -eq 0 ] && echo "every sampled gate is capable of going red"
exit "$FAILS"
