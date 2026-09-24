#!/usr/bin/env bash
# tools/live-verify.sh — the read-only half of the acceptance list that mechanical gates cannot
# reach (MIGRATION-NOTES §5.1 / §5.2 rows 3, 7, 9, 12 and Models items 9/18).
#
# It performs NO writes and never starts or restarts anything: it classifies the three-layer
# link (static bridge -> :8188 tunnel -> ComfyUI on the compute box), and when the link is
# actually live it prints the exact commands for the browser-side sweeps and the preset
# round trip, including their cleanup. Every state-changing step stays a command you read and
# run yourself.
#
# Exit codes: 0 link live and ready for the sweep, 2 link down (reason printed), 3 tooling
# missing (curl/lsof absent).
set -u

BRIDGE="${BRIDGE:-http://127.0.0.1:8000}"
TUNNEL_TARGET="${TUNNEL_TARGET:-http://127.0.0.1:8188}"
BOX="${BOX:-win30902}"
TIMEOUT=8

have() { command -v "$1" >/dev/null 2>&1; }
have curl || { echo "curl is required"; exit 3; }
probe() { # url -> "<code> <ms>"
  curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time "$TIMEOUT" "$1" 2>/dev/null || echo "000 timeout"
}

echo "== link ladder =="
read -r code ms <<<"$(probe "$BRIDGE/wfm_static/newui.html")"
printf '  bridge static   %-11s %s  (%ss)\n' "$code" "${code:+http}" "$ms"
STATIC_OK=0; [ "$code" = "200" ] && STATIC_OK=1

read -r code ms <<<"$(probe "$TUNNEL_TARGET/system_stats")"
TUNNEL_CODE="$code"
printf '  tunnel :8188    %s  (%ss)\n' "$code" "$ms"

read -r code ms <<<"$(probe "$BRIDGE/system_stats")"
BRIDGE_API_CODE="$code"
printf '  api via bridge  %s  (%ss)\n' "$code" "$ms"

if have lsof; then
  if lsof -nP -iTCP:8188 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  listener 8188   present"
  else
    echo "  listener 8188   MISSING -> no port forward: ssh -N -o ExitOnForwardFailure=yes -L 8188:127.0.0.1:8188 $BOX"
  fi
fi

LIVE=0
if [ "$BRIDGE_API_CODE" = "200" ] && [ "$TUNNEL_CODE" = "200" ]; then
  LIVE=1
  echo "  verdict: ComfyUI answers, the sweep below is meaningful"
else
  if [ "$STATIC_OK" = "1" ] && [ "$TUNNEL_CODE" != "200" ]; then
    if have lsof && lsof -nP -iTCP:8188 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  verdict: the forward listens but never answers, so ComfyUI itself is hung or gone."
      echo "           confirm on the box (read-only): ssh $BOX \"netstat -ano | findstr :8188\""
      echo "           LISTENING there + no answer here = restart ComfyUI there, not the bridge."
    else
      echo "  verdict: nothing forwards :8188. Re-open the tunnel, then re-run this script."
    fi
  elif [ "$TUNNEL_CODE" = "200" ] && [ "$BRIDGE_API_CODE" != "200" ]; then
    echo "  verdict: the box answers directly but the bridge does not proxy it - check the"
    echo "           process serving $BRIDGE and whether it predates the Origin rewrite in"
    echo "           tools/dev-server.js (writes 403 there while reads work)."
  else
    echo "  verdict: unreachable; nothing measured below this line is valid"
  fi
fi

cat <<'EOF'

== A sweep over an unreachable box still reports green, so gate on data, not on absence ==
Every browser sweep in this project asserts a data volume before trusting a "0 failures" line:
  /api/wfm/workflows    -> workflows > 0
  /object_info           -> classes > 1000
  #/generate?workflow=   -> controls > 50   (the form needs ~13 s here: /object_info is 16 MB)
An empty #/workflow yields 18 text samples; a loaded one yields 142. Same zero failures.

== Probes (they land in the gitignored build dir; prove that before trusting them) ==
EOF
if have git; then
  echo "  git check-ignore -v static/newui/axe.min.js static/newui/contrast-audit.mjs"
fi
cat <<'EOF'
  cp tools/contrast-audit.mjs static/newui/
  # axe-core, fetched outside the repo so no dependency is added:
  #   cd /tmp && npm pack axe-core --registry=https://registry.npmmirror.com
  #   tar xzf axe-core-*.tgz && cp package/axe.min.js <repo>/static/newui/

== In the page console, with the tab in the FOREGROUND (a hidden tab throttles timers, freezes
   transitions and rAF, offers no screenshot surface, and makes axe.run exceed any short budget) ==
  const m = await import("/wfm_static/newui/contrast-audit.mjs");
  await m.run();            // resolves only after the 12th view x theme row; throws if /system_stats fails
  m.results(); m.selfTest() // selfTest forces a bad colour: 0 clean vs 5 armed, or the audit is blind

  const s = document.createElement("script");
  s.src = "/wfm_static/newui/axe.min.js"; document.head.appendChild(s);
  for (const v of ["workflow","generate","models","prompt","gallery","settings"]) {
    location.hash = "#/" + v; await new Promise(r => setTimeout(r, 9000));
    const r = await axe.run(document, { resultTypes: ["violations"] });
    console.log(v, r.violations.map(x => x.id + "/" + x.nodes.length));
  }
  // and once more with a workflow loaded: #/generate?workflow=<file>.json

== Parity rows still needing the compute box ==
  row 3  a queued generation, watching onProgress go 0 -> 1 and the WS progress bookkeeping
  row 9  the result appearing in Gallery, and a gallery item loading its workflow back
  row 12 python tools/run_typhon_test.py end to end (its "untouched" half is the A1 hash gate)
  row 7  preset round trip through the UI - save, list, apply, delete - on a bridge started from
         current code (writes land in the plugin's own data/gen_presets.json; delete after)
  Models 9 / 18  batch Civitai fetch and bulk move-to-subdir; both write, so they stay manual

  Quick manual check of the write path without touching the UI (safe, it deletes nothing):
    curl -s -o /dev/null -w "%{http_code}\n" -X DELETE \
         -H "Origin: http://127.0.0.1:8000" \
         http://127.0.0.1:8000/api/wfm/gen_presets/__no_such_preset__
  (substitute the bridge you are testing; this script prints but never runs it)
  403 means the serving process predates the Origin rewrite in tools/dev-server.js;
  200 {"status":"ok","deleted":false} means writes will get through.
EOF
[ "$LIVE" = "1" ] && exit 0
exit 2
