"""CivitAI API integration service."""

import hashlib
import json
import logging
import ssl
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from ..config import DATA_DIR

logger = logging.getLogger(__name__)


def _make_ssl_context():
    """Return an SSL context with CA verification.

    1. certifi CA bundle (available in virtually all ComfyUI envs via torch→requests→certifi)
    2. System default SSL context (OS certificate store)
    Returns None if both fail — callers fall back to urlopen without context
    (Python's own default, which also uses certifi when available).
    SSL verification is never disabled to avoid MitM exposure.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    try:
        return ssl.create_default_context()
    except Exception:
        pass
    logger.warning("CivitAI: could not build SSL context; falling back to urllib default")
    return None


_SSL_CONTEXT = _make_ssl_context  # lazy sentinel


def _get_ssl_context():
    global _SSL_CONTEXT
    if callable(_SSL_CONTEXT):
        _SSL_CONTEXT = _make_ssl_context()
    return _SSL_CONTEXT


CIVITAI_API_BASE = "https://civitai.com/api/v1"
CIVITAI_CACHE_FILE = DATA_DIR / "civitai_cache.json"

# HTTPステータスコード: 指数バックオフでリトライする対象
_RETRY_CODES = {429, 500, 502, 503, 504}
_MAX_RETRIES = 3
# POST /model-versions/by-hash は最大100件まで一括送信可能
_BATCH_CHUNK_SIZE = 100


# サイドカーJSON（.metadata.json / .cm-info.json）の最大サイズ。巨大ファイルでメモリを使い切らないための上限
_SIDECAR_MAX_BYTES = 2 * 1024 * 1024


def _as_int(v):
    """数値IDだけを受け付ける（文字列に細工されたIDをURL等に埋め込まないため）。不正ならNone。"""
    try:
        if isinstance(v, bool):
            return None
        n = int(v)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


class CivitaiService:
    """Fetch and cache CivitAI model metadata."""

    def __init__(self):
        self._cache = None

    # ── キャッシュ管理 ────────────────────────────────────────

    def _load_cache(self):
        if self._cache is not None:
            return self._cache
        if CIVITAI_CACHE_FILE.exists():
            try:
                with open(CIVITAI_CACHE_FILE, "r", encoding="utf-8") as f:
                    self._cache = json.load(f)
                    return self._cache
            except Exception:
                pass
        self._cache = {}
        return self._cache

    def _save_cache(self):
        CIVITAI_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CIVITAI_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(self._cache, f, ensure_ascii=False, indent=2)

    def get_cached(self, sha256_hash):
        """Return cached CivitAI data for a given hash, or None."""
        cache = self._load_cache()
        return cache.get(sha256_hash.lower())

    def get_all_cached(self):
        """Return the full cache dict."""
        return self._load_cache()

    # ── APIキー / ヘッダー ────────────────────────────────────

    @staticmethod
    def _get_api_key():
        """Return CivitAI API key. Env var CIVITAI_API_KEY takes priority over settings.json."""
        import os
        env_key = os.environ.get("CIVITAI_API_KEY", "").strip()
        if env_key:
            return env_key
        try:
            from ..services.settings_service import SettingsService
            return SettingsService().load().get("civitai_api_key", "").strip() or None
        except Exception:
            return None

    def _build_headers(self):
        """Build request headers, optionally including Bearer token."""
        headers = {"User-Agent": "ComfyUI-Workflow-Studio/1.0"}
        api_key = self._get_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    # ── ハッシュ計算 ──────────────────────────────────────────

    @staticmethod
    def calculate_sha256(file_path, chunk_size=512 * 1024, cancel=None):
        """Calculate SHA256 hash of a file. cancel(threading.Event)がセットされたらNoneを返して中断。"""
        h = hashlib.sha256()
        path = Path(file_path)
        if not path.is_file():
            return None
        with open(path, "rb") as f:
            while True:
                if cancel is not None and cancel.is_set():
                    return None
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()  # 小文字16進数

    # ── 単体フェッチ (GET) ────────────────────────────────────

    def fetch_by_hash(self, sha256_hash):
        """Fetch model version info from CivitAI by SHA256 hash (GET).

        429/5xx は指数バックオフでリトライ。
        Returns dict with model info, or None if not found.
        Caches successful results.
        """
        sha256_lower = sha256_hash.lower()
        cache = self._load_cache()
        cached = cache.get(sha256_lower)
        # Stability Matrix(.cm-info.json)由来の簡易情報は画像一覧を持たないため、
        # 明示的な取得/更新ではAPIから完全な情報で上書きする
        if cached is not None and cached.get("source") != "cm-info":
            return cached

        url = f"{CIVITAI_API_BASE}/model-versions/by-hash/{sha256_hash.upper()}"

        for attempt in range(_MAX_RETRIES):
            try:
                req = Request(url, headers=self._build_headers())
                with urlopen(req, timeout=15, context=_get_ssl_context()) as resp:
                    data = json.loads(resp.read().decode("utf-8"))

                if not data or "id" not in data:
                    return None

                info = self._extract_info(data)
                cache[sha256_lower] = info
                self._save_cache()
                return info

            except HTTPError as e:
                if e.code == 404:
                    logger.debug("CivitAI: model not found for hash %s", sha256_hash[:16])
                    return None
                if e.code in _RETRY_CODES and attempt < _MAX_RETRIES - 1:
                    wait = 2 ** attempt
                    logger.warning("CivitAI %s: retrying in %ss (attempt %d/%d)",
                                   e.code, wait, attempt + 1, _MAX_RETRIES)
                    time.sleep(wait)
                    continue
                logger.warning("CivitAI API error: %s %s", e.code, e.reason)
                return None
            except (URLError, Exception) as e:
                if attempt < _MAX_RETRIES - 1:
                    wait = 2 ** attempt
                    logger.warning("CivitAI request failed: %s — retrying in %ss", e, wait)
                    time.sleep(wait)
                    continue
                logger.warning("CivitAI request failed: %s", e)
                return None

        return None

    # ── 一括フェッチ (POST) ───────────────────────────────────

    def _batch_fetch_post(self, sha256_hashes):
        """POST /model-versions/by-hash でハッシュリストを一括取得（最大100件/リクエスト）。

        レスポンスの files[].hashes.SHA256 でリクエストのハッシュと照合する。
        Returns: { sha256_lower: info_or_none }
        """
        if not sha256_hashes:
            return {}

        url = f"{CIVITAI_API_BASE}/model-versions/by-hash"
        results = {h.lower(): None for h in sha256_hashes}
        cache = self._load_cache()
        failed = set()

        for chunk_start in range(0, len(sha256_hashes), _BATCH_CHUNK_SIZE):
            chunk = sha256_hashes[chunk_start:chunk_start + _BATCH_CHUNK_SIZE]
            chunk_lower = {h.lower() for h in chunk}

            for attempt in range(_MAX_RETRIES):
                try:
                    body = json.dumps([h.upper() for h in chunk]).encode("utf-8")
                    req = Request(
                        url,
                        data=body,
                        headers={**self._build_headers(), "Content-Type": "application/json"},
                        method="POST",
                    )
                    with urlopen(req, timeout=30, context=_get_ssl_context()) as resp:
                        versions = json.loads(resp.read().decode("utf-8"))

                    # 各バージョンを files[].hashes.SHA256 でリクエストのハッシュと照合
                    for version_data in versions:
                        info = self._extract_info(version_data)
                        matched = False
                        for f in version_data.get("files", []):
                            file_sha256 = f.get("hashes", {}).get("SHA256", "").lower()
                            if file_sha256 in chunk_lower:
                                cache[file_sha256] = info
                                results[file_sha256] = info
                                matched = True
                                break
                        if not matched:
                            # files にハッシュがない場合は versionId で照合を試みる
                            logger.debug("CivitAI: could not match version %s to a requested hash",
                                         version_data.get("id"))
                    break  # チャンク成功

                except HTTPError as e:
                    if e.code in _RETRY_CODES and attempt < _MAX_RETRIES - 1:
                        wait = 2 ** attempt
                        logger.warning("CivitAI batch POST %s: retrying in %ss", e.code, wait)
                        time.sleep(wait)
                        continue
                    logger.warning("CivitAI batch POST error: %s %s", e.code, e.reason)
                    failed.update(chunk_lower)
                    break
                except (URLError, Exception) as e:
                    if attempt < _MAX_RETRIES - 1:
                        wait = 2 ** attempt
                        logger.warning("CivitAI batch POST failed: %s — retrying in %ss", e, wait)
                        time.sleep(wait)
                        continue
                    logger.warning("CivitAI batch POST failed: %s", e)
                    failed.update(chunk_lower)
                    break

        # 通信失敗したチャンクは「CivitAIに存在しない」と区別するため記録する
        self.last_failed_hashes = failed
        self._save_cache()
        return results

    # ── 情報抽出 ──────────────────────────────────────────────

    @staticmethod
    def _extract_info(data):
        """Extract relevant fields from CivitAI API response."""
        model = data.get("model", {})
        images = data.get("images", [])
        files = data.get("files", [])

        # プライマリファイルを特定
        primary_file = next((f for f in files if f.get("primary")), None)
        if not primary_file and files:
            primary_file = files[0]

        # 画像情報（URL・寸法・NSFWレベル）を最大5件取得
        image_list = []
        for img in images[:5]:
            img_url = img.get("url", "")
            if not img_url:
                continue
            image_list.append({
                "url": img_url,
                "width": img.get("width"),
                "height": img.get("height"),
                "nsfwLevel": img.get("nsfwLevel", 0),
            })

        # プライマリファイルのメタ情報（精度・フォーマット）
        file_meta = {}
        file_hashes = {}
        if primary_file:
            pm = primary_file.get("metadata", {})
            file_meta = {
                "fp": pm.get("fp"),
                "size": pm.get("size"),
                "format": pm.get("format"),
            }
            # BLAKE3, SHA256, AutoV2 等のハッシュ
            file_hashes = primary_file.get("hashes", {})

        stats = data.get("stats", {})

        # バッチ POST API は model オブジェクト内に id を含まない場合がある
        # トップレベルの modelId をフォールバックとして使用する
        model_id = model.get("id") or data.get("modelId")
        version_id = data.get("id", "")

        return {
            "versionId": version_id,
            "modelId": model_id,
            "modelName": model.get("name", ""),
            "versionName": data.get("name", ""),
            "type": model.get("type", ""),
            "description": data.get("description") or model.get("description", ""),
            "tags": model.get("tags", []),
            "nsfw": model.get("nsfw", False),
            "nsfwLevel": data.get("nsfwLevel", 0),
            "air": data.get("air", ""),
            "creator": data.get("creator", {}).get("username", ""),
            # 後方互換のため URLリストを維持しつつ詳細情報も保存
            "images": [img["url"] for img in image_list],
            "imageDetails": image_list,
            "trainedWords": data.get("trainedWords", []),
            "baseModel": data.get("baseModel", ""),
            "fileSize": primary_file.get("sizeKB", 0) if primary_file else 0,
            "fileMeta": file_meta,
            "fileHashes": file_hashes,
            "downloadUrl": data.get("downloadUrl", ""),
            "modelUrl": (
                f"https://civitai.com/models/{model_id}?modelVersionId={version_id}"
                if model_id else (
                    f"https://civitai.com/model-versions/{version_id}"
                    if version_id else ""
                )
            ),
            "stats": {
                "downloadCount": stats.get("downloadCount", 0),
                "thumbsUpCount": stats.get("thumbsUpCount", 0),
                "thumbsDownCount": stats.get("thumbsDownCount", 0),
            },
            "updatedAt": data.get("updatedAt", ""),
            "publishedAt": data.get("publishedAt", ""),
        }

    # ── バッチフェッチ ────────────────────────────────────────

    @staticmethod
    def _known_hash(known, st):
        """メタデータに保存済みのsha256が、現在のファイルに対して有効ならそれを返す。

        size/mtime が記録されていれば一致を確認する（ファイル差し替え検知）。
        記録の無い旧データは信頼する。
        """
        sha = (known or {}).get("sha256")
        if not sha:
            return None
        try:
            ks, km = known.get("size"), known.get("mtime")
            if ks is not None and int(ks) != st.st_size:
                return None
            if km is not None and abs(float(km) - st.st_mtime) > 2:
                return None
        except (TypeError, ValueError):
            return None
        return str(sha).lower()

    def _read_sidecar(self, file_path, size):
        """サイドカーからsha256とCivitAI情報を読む（ハッシュ計算・通信不要）。

        Lora Manager の `<stem>.metadata.json` → Stability Matrix の `<stem>.cm-info.json` の順に試す。
        Returns: (sha256_lower or None, extracted_info or None)
        """
        sha, info = self._read_lm_sidecar(file_path, size)
        if sha:
            return sha, info
        return self._read_cm_info(file_path)

    @staticmethod
    def _parse_iso_ts(value):
        """ISO8601文字列→epoch秒。.NETの7桁小数秒にも対応。失敗時はNone。"""
        try:
            import re
            from datetime import datetime
            s = str(value).replace("Z", "+00:00")
            s = re.sub(r"(\.\d{6})\d+", r"\1", s)
            return datetime.fromisoformat(s).timestamp()
        except Exception:
            return None

    def _read_cm_info(self, file_path):
        """Stability Matrix の `<stem>.cm-info.json` から sha256 とCivitAI簡易情報を読む。

        ファイルサイズ情報が無いため、ImportedAt より後にモデルファイルが更新されていたら不採用。
        画像一覧は持たないので info には "source": "cm-info" を付け、個別取得で完全情報に置き換えられる。
        """
        sc = file_path.with_name(file_path.stem + ".cm-info.json")
        try:
            if sc.stat().st_size > _SIDECAR_MAX_BYTES:  # 巨大ファイルによるメモリ消費を避ける
                return None, None
            with open(sc, "r", encoding="utf-8-sig") as f:
                d = json.load(f)
            if not isinstance(d, dict):
                return None, None
            sha = str((d.get("Hashes") or {}).get("SHA256", "")).lower()
            if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
                return None, None
            imported = self._parse_iso_ts(d.get("ImportedAt"))
            if imported is None or file_path.stat().st_mtime > imported + 2:
                return None, None
        except Exception:
            return None, None

        info = None
        try:
            if d.get("Source", 0) == 0 and _as_int(d.get("VersionId")):  # 0 = Civitai
                info = self._info_from_cm_info(d)
        except Exception:
            info = None
        return sha, info

    @staticmethod
    def _info_from_cm_info(d):
        """cm-info.json を _extract_info と同じ形式のdictに変換する。"""
        model_id, version_id = _as_int(d.get("ModelId")), _as_int(d.get("VersionId"))
        stats = d.get("Stats") or {}
        return {
            "versionId": version_id,
            "modelId": model_id,
            "modelName": d.get("ModelName", ""),
            "versionName": d.get("VersionName", ""),
            "type": d.get("ModelType", ""),
            "description": d.get("VersionDescription") or d.get("ModelDescription", ""),
            "tags": [str(x) for x in (d.get("Tags") or []) if isinstance(x, (str, int, float))][:100],
            "nsfw": bool(d.get("Nsfw", False)),
            "nsfwLevel": 0,
            "air": "",
            "creator": d.get("AuthorUsername") or "",
            "images": [],
            "imageDetails": [],
            "trainedWords": [str(x) for x in (d.get("TrainedWords") or []) if isinstance(x, (str, int, float))][:200],
            "baseModel": d.get("BaseModel") or "",
            "fileSize": 0,
            "fileMeta": d.get("FileMetadata") or {},
            "fileHashes": d.get("Hashes") or {},
            "downloadUrl": "",
            "modelUrl": (
                f"https://civitai.com/models/{model_id}?modelVersionId={version_id}"
                if model_id else f"https://civitai.com/model-versions/{version_id}"
            ),
            "stats": {
                "downloadCount": stats.get("downloadCount", 0),
                "thumbsUpCount": stats.get("thumbsUpCount", 0),
                "thumbsDownCount": stats.get("thumbsDownCount", 0),
            },
            "updatedAt": "",
            "publishedAt": "",
            "source": "cm-info",
        }

    def _read_lm_sidecar(self, file_path, size):
        """`<stem>.metadata.json` (Lora Manager) サイドカーからsha256とCivitAI情報を読む。

        サイドカーのsizeがファイルサイズと一致する場合のみ採用する。
        Returns: (sha256_lower or None, extracted_info or None)
        """
        sc = file_path.with_name(file_path.stem + ".metadata.json")
        try:
            if sc.stat().st_size > _SIDECAR_MAX_BYTES:
                return None, None
            with open(sc, "r", encoding="utf-8") as f:
                d = json.load(f)
            if not isinstance(d, dict):
                return None, None
            sha = str(d.get("sha256", "")).lower()
            if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
                return None, None
            if d.get("size") is None or int(float(d["size"])) != size:
                return None, None
        except Exception:
            return None, None

        info = None
        civ = d.get("civitai")
        if isinstance(civ, dict) and civ.get("id"):
            # 別ファイルの情報を取り込まないよう、files[].hashes.SHA256 に一致するものだけ採用
            matched = any(
                str(f.get("hashes", {}).get("SHA256", "")).lower() == sha
                for f in civ.get("files", []) if isinstance(f, dict)
            )
            if matched:
                try:
                    info = self._extract_info(civ)
                except Exception:
                    info = None
        return sha, info

    def batch_fetch(self, model_files, progress_callback=None, known=None, on_hash=None, workers=2, cancel=None, hash_missing=False):
        """Batch fetch CivitAI info for multiple model files.

        Phase 0: 保存済みsha256 / サイドカーから解決（ハッシュ計算・通信なし）
        Phase 1: 残りのSHA256を並列計算（"hashing"）— hash_missing=True のときのみ。
                 既定では計算せず needs_hash を返す
        Phase 2: POST で一括取得（"fetching"）— キャッシュ済みはスキップ

        Args:
            model_files: list of (model_name, file_path) tuples
            progress_callback: fn(current, total, model_name, status) called per model
            known: { model_name: {"sha256", "size", "mtime"} } メタデータ保存済みハッシュ
            on_hash: fn(model_name, sha256, size, mtime) ハッシュが新たに確定するたびに呼ばれる
            workers: ハッシュ計算の並列数
            cancel: threading.Event。セットされると未処理分を打ち切って戻る（クライアント切断時）

        Returns: dict of { model_name: { sha256, civitai_info_or_none } }
        """
        results = {}
        total = len(model_files)
        cache = self._load_cache()
        known = known or {}
        finished = 0
        cache_dirty = False

        hashes_needed = []  # [(model_name, sha256_lower)]
        to_hash = []        # [(model_name, file_path, stat)]

        def _resolved(name, sha, st, new_hash):
            """sha256確定後の共通処理。キャッシュにあれば完了、無ければ取得待ちへ。"""
            nonlocal finished
            results[name] = {"sha256": sha, "civitai": None}
            if new_hash and on_hash:
                on_hash(name, sha, st.st_size, st.st_mtime)
            if sha in cache:
                results[name]["civitai"] = cache[sha]
                finished += 1
                if progress_callback:
                    progress_callback(finished, total, name, "cached")
            else:
                hashes_needed.append((name, sha))

        # Phase 0: ハッシュ計算なしで解決できるものを先に処理
        for model_name, file_path in model_files:
            try:
                st = Path(file_path).stat()
            except OSError:
                results[model_name] = {"sha256": None, "civitai": None, "error": "hash_failed"}
                finished += 1
                if progress_callback:
                    progress_callback(finished, total, model_name, "not_found")
                continue

            sha = self._known_hash(known.get(model_name), st)
            if sha:
                _resolved(model_name, sha, st, new_hash=False)
                continue

            sha, info = self._read_sidecar(Path(file_path), st.st_size)
            if sha:
                if info and sha not in cache:
                    cache[sha] = info
                    cache_dirty = True
                _resolved(model_name, sha, st, new_hash=True)
                continue

            to_hash.append((model_name, file_path, st))

        if cache_dirty:
            self._save_cache()

        logger.info("CivitAI batch: total=%d resolved_without_hash=%d need_hash=%d hash_missing=%s",
                    total, len(results), len(to_hash), hash_missing)
        # ハッシュ未確定のものは、hash_missing=False（既定）なら計算せず "needs_hash" として返す
        # （個別取得でハッシュ計算する運用。全件ハッシュ計算は負荷が高いため行わない）
        if to_hash and not hash_missing:
            for model_name, _fp, _st in to_hash:
                results[model_name] = {"sha256": None, "civitai": None, "needs_hash": True}
                finished += 1
                if progress_callback:
                    progress_callback(finished, total, model_name, "needs_hash")
            to_hash = []

        # Phase 1: 残りを並列でハッシュ計算（hashlibは大きなチャンクでGILを解放する）
        if to_hash:
            from concurrent.futures import ThreadPoolExecutor, as_completed

            def _hash(item):
                return self.calculate_sha256(item[1], cancel=cancel)

            with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
                futures = {pool.submit(_hash, item): item for item in to_hash}
                for fut in as_completed(futures):
                    if cancel is not None and cancel.is_set():
                        for f in futures:
                            f.cancel()
                        break
                    model_name, _fp, st = futures[fut]
                    try:
                        sha = fut.result()
                    except Exception:
                        sha = None
                    if not sha:
                        results[model_name] = {"sha256": None, "civitai": None, "error": "hash_failed"}
                        finished += 1
                        if progress_callback:
                            progress_callback(finished, total, model_name, "not_found")
                        continue
                    if progress_callback:
                        progress_callback(finished, total, model_name, "hashing")
                    _resolved(model_name, sha.lower(), st, new_hash=True)

        if cancel is not None and cancel.is_set():
            return results

        # Phase 2: POST で一括取得（未キャッシュ分）
        if hashes_needed:
            if progress_callback:
                progress_callback(finished, total, "", "fetching")

            # 同一ハッシュが複数モデルに対応する場合を考慮
            sha256_to_names: dict[str, list] = {}
            for name, sha256_lower in hashes_needed:
                sha256_to_names.setdefault(sha256_lower, []).append(name)

            logger.info("CivitAI batch: POST %d hashes", len(sha256_to_names))
            batch_results = self._batch_fetch_post(list(sha256_to_names.keys()))
            logger.info("CivitAI batch: POST done")
            failed = getattr(self, "last_failed_hashes", set())

            for sha256_lower, info in batch_results.items():
                for name in sha256_to_names.get(sha256_lower, []):
                    results[name]["civitai"] = info
                    if not info and sha256_lower in failed:
                        results[name]["fetch_failed"] = True
                    finished += 1
                    if progress_callback:
                        status = "found" if info else "not_found"
                        progress_callback(finished, total, name, status)

        if progress_callback:
            progress_callback(total, total, "", "done")

        return results

    # ── 画像ダウンロード ──────────────────────────────────────

    @staticmethod
    def download_image(url, save_path, timeout=15):
        """Download an image from URL and save to save_path. Returns True on success."""
        try:
            req = Request(url, headers={"User-Agent": "ComfyUI-Workflow-Studio/1.0"})
            with urlopen(req, timeout=timeout, context=_get_ssl_context()) as resp:
                data = resp.read()
            with open(save_path, "wb") as f:
                f.write(data)
            return True
        except Exception as e:
            logger.warning("Failed to download preview from %s: %s", url, e)
            return False

    # ── キャッシュ操作 ────────────────────────────────────────

    def clear_cache(self, sha256_hash=None):
        """Clear cache for a specific hash or all."""
        cache = self._load_cache()
        if sha256_hash:
            cache.pop(sha256_hash.lower(), None)
        else:
            cache.clear()
        self._save_cache()
