#!/bin/sh
# 批量出图入口 —— 自动挑一个带 tomllib 的解释器（Python 3.11+）
#
# 用法：
#   tools/run_batch.sh run_rossi_batch.py 51
#   tools/run_batch.sh run_rossi_batch.py --only RF003,RG001
#
# 若机器上只有 Python 3.9/3.10，可先：python3 -m pip install --user tomli

for PY in python3.13 python3.12 python3.11 python3 \
          /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 \
          /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11; do
    if command -v "$PY" >/dev/null 2>&1 && "$PY" -c "import tomllib" >/dev/null 2>&1; then
        TARGET="$1"; shift
        exec "$PY" "$(dirname "$0")/$TARGET" "$@"
    fi
done

echo "❌ 找不到带 tomllib 的 Python（需要 3.11+）。" >&2
echo "   可选：python3 -m pip install --user tomli  然后直接跑 python3" >&2
exit 1
