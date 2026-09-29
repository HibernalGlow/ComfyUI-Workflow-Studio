#!/usr/bin/env bash
# tools/test-gates.sh — run every pure-function Python gate in tools/.
#
# These gates need no GPU and no running ComfyUI: they exercise the batch-time logic
# (story config, preset application, sampler wiring) against the real files in the repo.
# Two copies of the same rules drift, so each one here is a rule that has actually bitten
# a batch — see the header of each script for what it pins and why.
#
# Usage:  bash tools/test-gates.sh
#         npm run test:gates
# Exit status: number of gates that failed.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

GATES=(tools/test_*gate*.py)
if [ ! -e "${GATES[0]}" ]; then
    echo "no tools/test_*gate*.py found — the glob is wrong, not the code" >&2
    exit 1
fi

FAILED=0
for gate in "${GATES[@]}"; do
    printf '\n=== %s ===\n' "$gate"
    if python3 "$gate"; then
        printf '[ ok ] %s\n' "$gate"
    else
        printf '[FAIL] %s\n' "$gate"
        FAILED=$((FAILED + 1))
    fi
done

printf '\n%d gate(s) failed out of %d\n' "$FAILED" "${#GATES[@]}"
exit "$FAILED"
