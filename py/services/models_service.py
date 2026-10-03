"""Model metadata management service."""

import json
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from ..config import MODEL_METADATA_FILE

logger = logging.getLogger(__name__)

_SCAN_CACHE_TTL = 30  # seconds — reuse scan result within this window

# Preview image extensions to search for (in priority order)
_PREVIEW_EXTENSIONS = [".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp",
                       ".png", ".jpg", ".jpeg", ".webp"]

_SIDECAR_EXTENSIONS = [
    ".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp",
    ".png", ".jpg", ".jpeg", ".webp",
    ".metadata.json", ".cm-info.json", ".json", ".civitai.info", ".info",
    ".txt", ".trigger.txt", ".notrigger.txt", ".triggers.txt",
]

_DISABLED_SUFFIX = ".disabled"

_MODEL_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".pt2"}

# ComfyUI model type → folder_paths key mapping (supports singular & plural)
MODEL_TYPE_FOLDER_KEYS = {
    "checkpoint": "checkpoints",
    "checkpoints": "checkpoints",
    "lora": "loras",
    "loras": "loras",
    "vae": "vae",
    "vaes": "vae",
    "controlnet": "controlnet",
    "controlnets": "controlnet",
    "unet": "diffusion_models",
    "diffusion_models": "diffusion_models",
    "textencoder": "text_encoders",
    "text_encoders": "text_encoders",
    "hypernetwork": "hypernetworks",
    "hypernetworks": "hypernetworks",
    "embedding": "embeddings",
    "embeddings": "embeddings",
}


def _iter_files(root):
    """root 配下の全ファイルを返す。フォルダのシンボリックリンク／ジャンクションも辿る。

    リンクが祖先フォルダを指していて循環する場合のみ、その枝には入らない
    （rglob だとパス長上限まで再帰し続ける恐れがある）。
    """
    def walk(d, ancestors):
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            try:
                if e.is_dir():  # リンクは辿る
                    real = os.path.realpath(e.path)
                    if real in ancestors:
                        logger.warning("Skipping looping folder link: %s -> %s", e.path, real)
                        continue
                    yield from walk(e.path, ancestors | {real})
                elif e.is_file():
                    yield Path(e.path)
            except OSError:
                continue

    root = Path(root)
    yield from walk(root, frozenset([os.path.realpath(root)]))


def _is_within(path, root):
    """path が root 配下か。`..` は正規化するが、リンクは解決しない（リンク先フォルダへの移動を許可）。"""
    try:
        a, r = os.path.abspath(path), os.path.abspath(root)
        return os.path.commonpath([os.path.normcase(a), os.path.normcase(r)]) == os.path.normcase(r)
    except ValueError:  # 別ドライブなど
        return False


# 追加モデルルート配下で探すサブフォルダ名（大小無視）。ComfyUI標準名 + Stability Matrix名
_EXTRA_ROOT_SUBDIRS = {
    "checkpoint": ["checkpoints", "StableDiffusion"],
    "lora": ["loras", "Lora"],
    "vae": ["vae", "VAE"],
    "controlnet": ["controlnet", "ControlNet"],
    "unet": ["diffusion_models", "DiffusionModels", "unet"],
    "textencoder": ["text_encoders", "TextEncoders", "clip"],
    "hypernetwork": ["hypernetworks", "HyperNetworks"],
    "embedding": ["embeddings", "Embeddings"],
}


def parse_extra_model_roots(value):
    """設定値（`;` または改行区切りの文字列）を重複なしのパス文字列リストにする。"""
    if isinstance(value, (list, tuple)):
        value = ";".join(str(v) for v in value)
    parts = str(value or "").replace("\n", ";").split(";")
    seen, out = set(), []
    for p in parts:
        p = p.strip().strip('"')
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _get_extra_model_dirs(model_type):
    """設定 `models_dir` で追加指定されたルート配下の、該当タイプのフォルダを返す。"""
    names = _EXTRA_ROOT_SUBDIRS.get(model_type)
    if not names:
        return []
    try:
        from .settings_service import SettingsService
        roots = parse_extra_model_roots(SettingsService().load().get("models_dir", ""))
    except Exception:
        return []
    wanted = {n.lower() for n in names}
    found = []
    for root in roots:
        try:
            for e in os.scandir(root):
                if e.is_dir() and e.name.lower() in wanted:
                    found.append(Path(e.path))
        except OSError:
            logger.warning("Configured models_dir not accessible: %s", root)
    return found


def _get_model_dirs(model_type):
    """Get all model directories for a type using ComfyUI's folder_paths.

    Returns a list of Path objects for all configured model directories
    (includes extra_model_paths.yaml settings and the `models_dir` setting).
    Falls back to plugin-relative path if folder_paths is unavailable.
    """
    folder_key = MODEL_TYPE_FOLDER_KEYS.get(model_type)
    if not folder_key:
        return []

    result = []
    try:
        import folder_paths  # type: ignore  # ComfyUI module
        paths = folder_paths.get_folder_paths(folder_key)
        result = [Path(p) for p in paths if Path(p).is_dir()]
    except Exception as e:
        logger.debug("folder_paths unavailable (%s), using fallback", e)

    if not result:
        # Fallback: custom_nodes/../../models/{folder_key}
        plugin_dir = Path(__file__).resolve().parent.parent.parent
        models_dir = plugin_dir.parent.parent / "models" / folder_key
        if models_dir.is_dir():
            result = [models_dir]

    # 設定で追加されたルート（既存と同一実体は除外）
    known = {os.path.normcase(os.path.realpath(p)) for p in result}
    for d in _get_extra_model_dirs(model_type):
        key = os.path.normcase(os.path.realpath(d))
        if key not in known:
            known.add(key)
            result.append(d)
    return result


class ModelsService:
    """Manages user-defined model metadata (favorites, tags, memo)."""

    def __init__(self):
        self.metadata_file = MODEL_METADATA_FILE
        self._scan_cache: dict = {}  # model_type -> (timestamp, frozenset)

    def _now_iso(self):
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    def _load_metadata(self):
        if self.metadata_file.exists():
            try:
                with open(self.metadata_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _save_metadata(self, data):
        self.metadata_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.metadata_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get_all_metadata(self):
        return self._load_metadata()

    def update_metadata(self, model_name, updates):
        data = self._load_metadata()
        if model_name not in data:
            data[model_name] = {"tags": [], "favorite": False, "memo": ""}
        entry = data[model_name]
        if "tags" in updates:
            entry["tags"] = updates["tags"]
        if "favorite" in updates:
            entry["favorite"] = updates["favorite"]
        if "memo" in updates:
            entry["memo"] = updates["memo"]
        if "sha256" in updates:
            entry["sha256"] = updates["sha256"]
        if "badges" in updates:
            entry["badges"] = updates["badges"]
        if "civitaiNotFound" in updates:
            # CivitAIに存在しなかった記録（一括取得のスキップ用）。None/False で解除
            if updates["civitaiNotFound"]:
                entry["civitaiNotFound"] = self._now_iso()
            else:
                entry.pop("civitaiNotFound", None)
        entry["updatedAt"] = self._now_iso()
        data[model_name] = entry
        self._save_metadata(data)
        return entry

    def _scan_model_names(self, model_type: str) -> set:
        """モデルタイプの全ファイル名をスキャンして返す（相対パス、/区切り、.disabled除く）。
        結果は30秒キャッシュされ、起動時の多重スキャンによる高負荷を防ぐ。"""
        now = time.monotonic()
        cached = self._scan_cache.get(model_type)
        if cached is not None:
            ts, names = cached
            if now - ts < _SCAN_CACHE_TTL:
                return names

        dirs = _get_model_dirs(model_type)
        names = set()
        for d in dirs:
            if not d.is_dir():
                continue
            for f in _iter_files(d):
                try:
                    rel = str(f.relative_to(d)).replace("\\", "/")
                    if rel.endswith(_DISABLED_SUFFIX):
                        rel = rel[: -len(_DISABLED_SUFFIX)]
                    names.add(rel)
                except ValueError:
                    pass

        self._scan_cache[model_type] = (now, names)
        return names

    def list_model_files(self, model_type: str, extra_only: bool = False) -> list:
        """モデルタイプのモデルファイル名をソートして返す（拡張子付き、/区切り）。
        プレビュー画像やサイドカーファイルを除外し、モデル拡張子のみを返す。
        extra_only=True なら設定 models_dir で追加されたフォルダのみ対象。"""
        dirs = _get_extra_model_dirs(model_type) if extra_only else _get_model_dirs(model_type)
        seen = set()
        for d in dirs:
            if not d.is_dir():
                continue
            for f in _iter_files(d):
                name = f.name
                if name.endswith(_DISABLED_SUFFIX):
                    name = name[: -len(_DISABLED_SUFFIX)]
                if Path(name).suffix.lower() not in _MODEL_EXTENSIONS:
                    continue
                try:
                    rel = str(f.relative_to(d)).replace("\\", "/")
                    if rel.endswith(_DISABLED_SUFFIX):
                        rel = rel[: -len(_DISABLED_SUFFIX)]
                    seen.add(rel)
                except ValueError:
                    pass
        return sorted(seen)

    def get_model_groups(self, model_type=None):
        data = self._load_metadata()
        raw = data.get("_groups", {})

        # Migrate old flat format { "groupName": [...] } → per-type { "checkpoint": {...} }
        if raw and not any(k in MODEL_TYPE_FOLDER_KEYS for k in raw):
            logger.info("Migrating groups to per-type format (old data moved to _groups_legacy)")
            data["_groups_legacy"] = raw
            data["_groups"] = {}
            self._save_metadata(data)
            raw = {}

        if model_type:
            groups = raw.get(model_type, {})

            # Guard: if no model directories are accessible (e.g. network drive disconnected),
            # skip cleanup entirely to prevent mass-deletion of group members.
            accessible_dirs = [d for d in _get_model_dirs(model_type) if d.is_dir()]
            if not accessible_dirs:
                configured_dirs = _get_model_dirs(model_type)
                if configured_dirs:
                    logger.warning(
                        "No accessible directories for model_type=%s — skipping group cleanup "
                        "to avoid data loss (drives may be disconnected)", model_type
                    )
                    return {g: [m.replace("\\", "/") for m in members]
                            for g, members in groups.items()}
                # No directories configured at all — return as-is (nothing to validate against)
                return {g: [m.replace("\\", "/") for m in members] for g, members in groups.items()}

            valid_names = self._scan_model_names(model_type)
            cleaned = {}
            dirty = False
            for g_name, members in groups.items():
                # Normalize backslashes (Windows ComfyUI paths) to forward slashes
                normalized = [m.replace("\\", "/") for m in members]
                filtered = [m for m in normalized if m in valid_names]
                cleaned[g_name] = filtered
                if len(filtered) != len(members) or normalized != list(members):
                    dirty = True
            if dirty:
                removed = sum(len(groups[g]) - len(cleaned[g]) for g in groups)
                if removed > 0:
                    logger.info("Cleaned up %d stale group entries for model_type=%s", removed, model_type)
                if not isinstance(data.get("_groups"), dict):
                    data["_groups"] = {}
                data["_groups"][model_type] = cleaned
                self._save_metadata(data)
            return cleaned
        return raw

    def save_model_groups(self, groups, model_type):
        # Normalize all member names to forward slashes (ComfyUI on Windows uses backslashes)
        normalized = {g: [m.replace("\\", "/") for m in members] for g, members in groups.items()}
        data = self._load_metadata()
        if not isinstance(data.get("_groups"), dict):
            data["_groups"] = {}
        data["_groups"][model_type] = normalized
        self._save_metadata(data)
        # Also invalidate scan cache so next get_model_groups sees the fresh data
        self._scan_cache.pop(model_type, None)
        return normalized

    def find_model_file(self, model_type, model_name):
        """Find a model file, checking both enabled and disabled states.

        Returns (Path, is_enabled) or (None, None) if not found.
        """
        dirs = _get_model_dirs(model_type)
        for d in dirs:
            enabled = d / model_name
            if enabled.is_file():
                return enabled, True
            disabled = d / (model_name + _DISABLED_SUFFIX)
            if disabled.is_file():
                return disabled, False
        return None, None

    def enable_model(self, model_type, model_name):
        """Rename model.safetensors.disabled → model.safetensors."""
        path, is_enabled = self.find_model_file(model_type, model_name)
        if path is None:
            raise FileNotFoundError(f"Model not found: {model_name}")
        if is_enabled:
            return
        target = path.parent / path.name[: -len(_DISABLED_SUFFIX)]
        path.rename(target)
        logger.info("Enabled model: %s", model_name)

    def disable_model(self, model_type, model_name):
        """Rename model.safetensors → model.safetensors.disabled."""
        path, is_enabled = self.find_model_file(model_type, model_name)
        if path is None:
            raise FileNotFoundError(f"Model not found: {model_name}")
        if not is_enabled:
            return
        target = path.parent / (path.name + _DISABLED_SUFFIX)
        path.rename(target)
        logger.info("Disabled model: %s", model_name)

    def scan_disabled_models(self, model_type):
        """Scan directories for .disabled files.

        Returns list of normalized model names (without .disabled suffix).
        """
        dirs = _get_model_dirs(model_type)
        disabled = []
        for d in dirs:
            if not d.is_dir():
                continue
            for f in _iter_files(d):
                if f.name.endswith(_DISABLED_SUFFIX):
                    try:
                        rel = str(f.relative_to(d))
                        if rel.endswith(_DISABLED_SUFFIX):
                            rel = rel[: -len(_DISABLED_SUFFIX)]
                        disabled.append(rel.replace("\\", "/"))
                    except ValueError:
                        pass
        return disabled

    def list_preview_keys(self, model_type):
        """プレビュー画像を持つモデルのキー（`サブフォルダ/ファイル名(拡張子なし)`、小文字・/区切り）を返す。

        一覧表示で「プレビューが無いモデルには画像リクエストを出さない」ために、フォルダを1回走査して求める
        （画像ごとの404リクエストと接続の開閉を避ける）。判定は find_preview_image と同じ拡張子・サイズ条件。
        """
        keys = set()
        for d in _get_model_dirs(model_type):
            if not d.is_dir():
                continue
            for f in _iter_files(d):
                lname = f.name.lower()
                exts = [e for e in _PREVIEW_EXTENSIONS if lname.endswith(e)]
                if not exts:
                    continue
                try:
                    if f.stat().st_size < 100:
                        continue
                    parent = str(f.parent.relative_to(d)).replace("\\", "/")
                except (OSError, ValueError):
                    continue
                prefix = "" if parent == "." else parent.lower() + "/"
                for e in exts:
                    keys.add(prefix + lname[: -len(e)])
        return sorted(keys)

    def find_preview_image(self, model_type, model_name):
        """Find preview image for a model file.

        Searches all configured directories for the model type
        (via ComfyUI's folder_paths, which includes extra_model_paths.yaml).

        Looks for files like:
            modelname.preview.png, modelname.png, etc.
        next to the model file. Supports cross-platform slashes and name variants.

        Returns: absolute Path to preview image, or None.
        """
        dirs = _get_model_dirs(model_type)
        if not dirs:
            logger.debug("Preview: no dirs for model_type=%s", model_type)
            return None

        # Cross-platform safe path split
        norm_parts = [p for p in model_name.replace("\\", "/").split("/") if p and p != ".."]

        for type_dir in dirs:
            model_path = type_dir.joinpath(*norm_parts)
            # 無効化されたモデル（<name>.disabled）でも、隣のプレビュー画像は探す
            disabled_path = model_path.with_name(model_path.name + _DISABLED_SUFFIX)
            if not model_path.is_file() and not disabled_path.is_file():
                continue

            stem = model_path.stem
            parent = model_path.parent

            # Candidate stems: exact stem, stem without @trigger, stem without style- prefix
            candidate_stems = [stem]
            clean_at = re.sub(r'@.*$', '', stem)
            if clean_at and clean_at not in candidate_stems:
                candidate_stems.append(clean_at)
            clean_style = re.sub(r'^(style[-_]|anima[-_]|illus[-_])', '', stem, flags=re.IGNORECASE)
            if clean_style and clean_style not in candidate_stems:
                candidate_stems.append(clean_style)

            for c_stem in candidate_stems:
                for ext in _PREVIEW_EXTENSIONS:
                    preview = parent / (c_stem + ext)
                    if preview.is_file() and preview.stat().st_size >= 100:
                        logger.debug("Preview found: %s", preview)
                        return preview

            logger.debug("Preview: no preview for %s (stem=%s, dir=%s)",
                         model_name, stem, parent)
            return None

        logger.debug("Preview: model file not found in any dir: %s", model_name)
        return None

    def delete_model(self, model_type, model_name):
        """Delete a model file and all associated preview/sidecar files.

        Also removes the model's metadata entry.
        Returns dict with deleted file paths.
        """
        if ".." in model_name:
            raise ValueError(f"Invalid model name: {model_name}")

        path, _ = self.find_model_file(model_type, model_name)
        if path is None:
            raise FileNotFoundError(f"Model not found: {model_name}")

        deleted = []
        parent = path.parent

        # Compute stem from the original (non-disabled) filename.
        # path.name for a disabled file is e.g. "model.safetensors.disabled"
        # so we strip the .disabled suffix first, then take Path.stem.
        orig_name = path.name
        if orig_name.endswith(_DISABLED_SUFFIX):
            orig_name = orig_name[: -len(_DISABLED_SUFFIX)]
        stem = Path(orig_name).stem  # "model.safetensors" -> "model"

        # Delete the model file itself
        path.unlink()
        deleted.append(str(path))
        logger.info("Deleted model file: %s", path)

        # Delete all sidecar files (previews, metadata, info)
        for ext in _SIDECAR_EXTENSIONS:
            sidecar = parent / (stem + ext)
            if sidecar.is_file():
                sidecar.unlink()
                deleted.append(str(sidecar))
                logger.info("Deleted sidecar: %s", sidecar)

        # Remove metadata entry
        data = self._load_metadata()
        if model_name in data:
            del data[model_name]
            self._save_metadata(data)

        return {"deleted": deleted}

    def get_subdirs(self, model_type):
        """Return sorted list of subdirectory names (including nested) for a model type."""
        dirs = _get_model_dirs(model_type)
        subdirs = set()
        for d in dirs:
            if not d.is_dir():
                continue
            for item in d.rglob("*"):
                if item.is_dir() and not any(part.startswith(".") for part in item.parts):
                    try:
                        rel = str(item.relative_to(d)).replace("\\", "/")
                        subdirs.add(rel)
                    except ValueError:
                        pass
        return sorted(subdirs)

    def move_models(self, model_type, model_names, dest_subdir):
        """Move model files + sidecar files to dest_subdir (can be nested like 'anima/artist/260924').

        dest_subdir: "" = model root, "sdxl" = <root>/sdxl/, "anima/artist" = <root>/anima/artist/
        Creates the destination directory if it does not exist.
        Updates metadata keys to reflect new paths.
        Returns {"moved": [{"from": ..., "to": ...}], "errors": [...]}
        """
        if dest_subdir:
            dest_subdir = dest_subdir.replace("\\", "/").strip("/")
            if ".." in dest_subdir.split("/"):
                return {"moved": [], "errors": [{"model": "*", "error": "Invalid destination: '..' not allowed"}]}
            if Path(dest_subdir).is_absolute():
                return {"moved": [], "errors": [{"model": "*", "error": "Invalid destination: absolute paths not allowed"}]}

        moved = []
        errors = []
        model_dirs = _get_model_dirs(model_type)

        meta_data = self._load_metadata()
        meta_changed = False
        renames = []  # [(old_name, new_name)]

        for model_name in model_names:
            if ".." in model_name:
                errors.append({"model": model_name, "error": "Invalid model name"})
                continue

            path, _is_enabled = self.find_model_file(model_type, model_name)
            if path is None:
                errors.append({"model": model_name, "error": f"Model not found: {model_name}"})
                continue

            try:
                # Determine which root dir this model lives in
                root_dir = None
                for d in model_dirs:
                    try:
                        path.relative_to(d)
                        root_dir = d
                        break
                    except ValueError:
                        pass
                if root_dir is None:
                    errors.append({"model": model_name, "error": "Cannot determine root directory"})
                    continue

                # Destination directory — verify it stays within root_dir (`..`/絶対パスは拒否。
                # フォルダのシンボリックリンク／ジャンクション配下への移動は許可する)
                dest_dir = root_dir / dest_subdir if dest_subdir else root_dir
                if not _is_within(dest_dir, root_dir):
                    errors.append({"model": model_name, "error": "Destination is outside model root"})
                    continue
                dest_dir.mkdir(parents=True, exist_ok=True)

                # Original filename without .disabled suffix
                orig_name = path.name
                if orig_name.endswith(_DISABLED_SUFFIX):
                    orig_name = orig_name[: -len(_DISABLED_SUFFIX)]
                stem = Path(orig_name).stem

                new_path = dest_dir / path.name
                if new_path.resolve() == path.resolve():
                    errors.append({"model": model_name, "error": "Already in destination"})
                    continue

                # Refuse to overwrite an existing file
                if new_path.exists():
                    errors.append({"model": model_name, "error": f"Destination already exists: {path.name}"})
                    continue

                # Move the model file
                shutil.move(str(path), str(new_path))
                logger.info("Moved model: %s → %s", path, new_path)

                # Move all sidecar files (skip if destination already exists)
                for ext in _SIDECAR_EXTENSIONS:
                    sidecar = path.parent / (stem + ext)
                    if sidecar.is_file():
                        sidecar_dest = dest_dir / (stem + ext)
                        if sidecar_dest.exists():
                            logger.warning("Sidecar destination exists, skipping: %s", sidecar_dest)
                            continue
                        try:
                            shutil.move(str(sidecar), str(sidecar_dest))
                        except Exception as se:
                            logger.warning("Could not move sidecar %s: %s", sidecar, se)

                # Compute new logical model name (relative to root, forward slashes)
                new_rel = str(new_path.relative_to(root_dir)).replace("\\", "/")
                if new_rel.endswith(_DISABLED_SUFFIX):
                    new_rel = new_rel[: -len(_DISABLED_SUFFIX)]

                # Update metadata key
                if model_name in meta_data:
                    meta_data[new_rel] = meta_data.pop(model_name)
                    meta_changed = True

                moved.append({"from": model_name, "to": new_rel})
                renames.append((model_name, new_rel))

            except Exception as e:
                logger.error("Error moving model %s: %s", model_name, e)
                errors.append({"model": model_name, "error": str(e)})

        # Update group entries for renamed/moved models
        if renames:
            groups_for_type = meta_data.get("_groups", {}).get(model_type, {})
            groups_dirty = False
            for old_name, new_name in renames:
                for members in groups_for_type.values():
                    for i, m in enumerate(members):
                        if m == old_name:
                            members[i] = new_name
                            groups_dirty = True
            if groups_dirty:
                if not isinstance(meta_data.get("_groups"), dict):
                    meta_data["_groups"] = {}
                meta_data["_groups"][model_type] = groups_for_type
                meta_changed = True

        if meta_changed:
            self._save_metadata(meta_data)

        return {"moved": moved, "errors": errors}

    def rename_model(self, model_type: str, old_name: str, new_name: str) -> dict:
        """Rename a model file and all its associated sidecar/preview/trigger files.

        old_name: e.g. "anima/artist/260924/@freng.safetensors"
        new_name: e.g. "freng_v1" (stem) or "freng_v1.safetensors" (with extension)
        """
        if not old_name or not new_name:
            raise ValueError("old_name and new_name are required")
        if ".." in old_name or ".." in new_name:
            raise ValueError("Invalid name: '..' not allowed")

        path, is_enabled = self.find_model_file(model_type, old_name)
        if path is None:
            raise FileNotFoundError(f"Model not found: {old_name}")

        model_dirs = _get_model_dirs(model_type)
        root_dir = None
        for d in model_dirs:
            try:
                path.relative_to(d)
                root_dir = d
                break
            except ValueError:
                pass
        if root_dir is None:
            raise ValueError("Cannot determine root directory")

        parent = path.parent
        orig_name = path.name
        is_disabled = orig_name.endswith(_DISABLED_SUFFIX)
        if is_disabled:
            orig_name = orig_name[: -len(_DISABLED_SUFFIX)]

        old_ext = Path(orig_name).suffix
        old_stem = Path(orig_name).stem

        # Clean new_name
        clean_new = Path(new_name).name
        if clean_new.endswith(old_ext):
            new_stem = clean_new[: -len(old_ext)]
            target_filename = clean_new
        else:
            new_stem = Path(clean_new).stem
            target_filename = new_stem + old_ext

        if not new_stem:
            raise ValueError("New model stem cannot be empty")

        final_new_name = target_filename + (_DISABLED_SUFFIX if is_disabled else "")
        target_path = parent / final_new_name
        if target_path.exists() and target_path.resolve() != path.resolve():
            raise FileExistsError(f"Target file already exists: {target_filename}")

        renamed_files = []

        # 1. Rename main model file
        path.rename(target_path)
        renamed_files.append({"from": str(path), "to": str(target_path)})
        logger.info("Renamed model: %s -> %s", path, target_path)

        # 2. Rename all sidecars (previews, trigger text files, etc.)
        for ext in _SIDECAR_EXTENSIONS:
            old_sidecar = parent / (old_stem + ext)
            if old_sidecar.is_file():
                new_sidecar = parent / (new_stem + ext)
                if not new_sidecar.exists():
                    try:
                        old_sidecar.rename(new_sidecar)
                        renamed_files.append({"from": str(old_sidecar), "to": str(new_sidecar)})
                        logger.info("Renamed sidecar: %s -> %s", old_sidecar, new_sidecar)
                    except Exception as se:
                        logger.warning("Could not rename sidecar %s: %s", old_sidecar, se)

        # 3. Compute new relative name
        new_rel = str(target_path.relative_to(root_dir)).replace("\\", "/")
        if new_rel.endswith(_DISABLED_SUFFIX):
            new_rel = new_rel[: -len(_DISABLED_SUFFIX)]

        # 4. Update metadata
        meta_data = self._load_metadata()
        meta_changed = False
        if old_name in meta_data:
            meta_data[new_rel] = meta_data.pop(old_name)
            meta_changed = True

        # 5. Update groups
        groups_for_type = meta_data.get("_groups", {}).get(model_type, {})
        for members in groups_for_type.values():
            for i, m in enumerate(members):
                if m == old_name:
                    members[i] = new_rel
                    meta_changed = True

        if meta_changed:
            self._save_metadata(meta_data)

        return {
            "status": "ok",
            "from": old_name,
            "to": new_rel,
            "new_filename": target_filename,
            "renamed_files": renamed_files,
        }

