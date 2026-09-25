#!/bin/sh
# 等 ComfyUI 的模型路径恢复正常再开跑。
#
# 背景：ComfyUI 的实例配置里如果挂了当前不存在的模型根目录（例如掉盘的 E:\...），
# int8-fast 之类节点在 INPUT_TYPES() 里调 folder_paths.get_filename_list() 会抛
# FileNotFoundError，导致 /prompt 一律 400。此时跑批只会空烧，不如等就绪。
#
# 探针用 GET /object_info/<节点>：节点 schema 能正常返回 200 就说明模型路径都通。
#
# 用法：
#   tools/wait_and_run.sh run_rossi_batch.py 160
#   PROBE_NODE=OTUNetLoaderW8A8 MAX_WAIT=7200 tools/wait_and_run.sh run_rossi_batch.py 160

PROBE_NODE="${PROBE_NODE:-OTUNetLoaderW8A8}"
PROBE="http://127.0.0.1:8188/object_info/${PROBE_NODE}"
MAX_WAIT="${MAX_WAIT:-7200}"       # 最多等 2 小时
INTERVAL="${INTERVAL:-30}"
HERE="$(dirname "$0")"

waited=0
while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$PROBE" 2>/dev/null)
    if [ "$code" = "200" ]; then
        echo "[$(date +%H:%M:%S)] ✅ 后端模型路径就绪（$PROBE_NODE 返回 200），开始跑批"
        exec "$HERE/run_batch.sh" "$@"
    fi
    if [ "$waited" -ge "$MAX_WAIT" ]; then
        echo "[$(date +%H:%M:%S)] ❌ 等待超时（${MAX_WAIT}s），后端仍是 HTTP $code —— 未开跑" >&2
        echo "   探针：$PROBE" >&2
        echo "   常见原因：实例配置里挂着不存在的模型根目录（掉盘）。" >&2
        exit 1
    fi
    echo "[$(date +%H:%M:%S)] ⏳ 后端未就绪（HTTP $code），${INTERVAL}s 后重试… 已等 ${waited}s"
    sleep "$INTERVAL"
    waited=$((waited + INTERVAL))
done
