"""ComfyUI-Lora-Manager 連携: LMが保持済みのsha256を再利用してハッシュ計算を省く。

LMの `/api/lm/{prefix}/list` は sha256 / file_path / file_size を返す（CivitAI詳細は薄いので
情報そのものは使わず、重いハッシュ計算の省略にのみ利用する）。LM未導入・失敗時は空を返す。
"""

import json
import logging
import os
from urllib.request import urlopen

logger = logging.getLogger(__name__)

# 当アプリのモデルタイプ → LMのルート接頭辞
_LM_PREFIX = {"checkpoint": "checkpoints", "lora": "loras", "embedding": "embeddings"}

_PAGE_SIZE = 100  # LM側の上限
_MAX_PAGES = 200
_TIMEOUT = 5


def _norm(path):
    return os.path.normcase(os.path.abspath(path))


def fetch_lm_hashes(origin, model_type):
    """Returns { normalized_file_path: {"sha256", "size"} }。LMが使えなければ {}。"""
    prefix = _LM_PREFIX.get(model_type)
    if not prefix:
        return {}
    out = {}
    try:
        page = 1
        while page <= _MAX_PAGES:
            url = f"{origin}/api/lm/{prefix}/list?page={page}&page_size={_PAGE_SIZE}"
            with urlopen(url, timeout=_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            for it in data.get("items", []):
                sha, fp = it.get("sha256"), it.get("file_path")
                if sha and fp and len(str(sha)) == 64:
                    out[_norm(fp)] = {"sha256": str(sha).lower(), "size": it.get("file_size")}
            if page >= int(data.get("total_pages", 1) or 1):
                break
            page += 1
    except Exception as e:
        logger.info("Lora Manager hashes unavailable (%s): %s", prefix, e)
        return {}
    return out
