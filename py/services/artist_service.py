"""LoRA & Artist discovery, categorization, and management service for Workflow Studio."""

import logging
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Any

from .models_service import _get_model_dirs, _PREVIEW_EXTENSIONS

logger = logging.getLogger(__name__)

# Known name mappings for cleaner display
KNOWN_NAME_MAP = {
    "oyari_ashito": "Oyari Ashito (尾崎隼秀)",
    "oyari": "Oyari (自练)",
    "bubutuke": "Bubutuke (布布杜克)",
    "freng": "Freng",
    "atdan": "Atdan (阿特丹)",
    "villainchin": "Villainchin",
    "imazawa": "Imazawa",
    "nnmbpx": "NNMBPX (nnmbpv)",
    "scallionflavor": "Scallionflavor (葱香)",
    "chen-bin": "Chen-Bin (陈斌)",
    "chenbin": "Chen-Bin",
    "pija": "Pija (pianiishimo)",
    "jima": "JIMA",
    "kaede_sayappa": "さやっぱ (sayappa) 楓 kaede",
    "sayappa": "さやっぱ (sayappa)",
    "waterkumastyle": "Waterkuma (水熊)",
    "turisasustyle": "Turisasu",
    "tatatsustyle": "Tatatsu",
    "shanyaostyle": "Shanyao",
    "qaqstyle": "QAQ",
    "ponyarastyle": "Ponyara",
    "nanaostyle": "Nanao",
    "loongmstyle": "Loongm",
    "kingbolestyle": "Kingbole",
    "jagaya": "Jagaya",
    "irisstyle": "Iris",
    "emilystyle": "Emily",
    "criin": "Criin",
    "cilorankostyle": "Ciloranko",
    "chocostyle": "Choco",
    "arikawa satoru": "Arikawa Satoru",
    "kuromoon": "Kuromoon",
    "santa": "SANTA (rtkt)",
    "mgk000": "mgk000",
    "kincora": "Kincora",
    "smilejiaozi": "Smilejiaozi (饺子)",
    "healthyman": "Healthyman",
    "xaea": "Xaea-xp",
    "mikozin": "Mikozin",
    "rella": "Rella",
    "liduke": "Liduke (日天)",
    "kanzarin": "Kanzarin",
    "mikapikazo": "Mika Pikazo",
    "hews": "Hews",
    "laffey": "拉菲 (Laffey)",
    "typhoeus": "提丰 (Typhoeus)",
    "rossi": "洛茜 (Rossi)",
    "niannian": "念念 (Niannian)",
    "ankasha": "安卡希雅 (Ankasha)",
    "saileach": "琴柳 (Saileach)",
    "ustirrup": "镫袜足交 (Ustirrup)",
    "stirrup": "镫袜 (Stirrup)",
    "turbo": "Turbo 极速加速",
    "aesthetic": "Aesthetic 美学提升",
    "cervical": "深入 (Cervical Penetration)",
}


def _clean_display_name(stem: str, category: str) -> str:
    """Derive a friendly display name from the file stem."""
    lower = stem.lower()
    for k, v in KNOWN_NAME_MAP.items():
        if k in lower:
            return v

    name = stem
    name = re.sub(r'^(style[-_]|anima[-_]|illus[-_]|@)', '', name, flags=re.IGNORECASE)
    name = re.sub(r'[-_](anima|illus|lora|v\d+.*|epoch\d+.*|step\d+.*|\d{6}.*)$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'@.*$', '', name)  # strip @trigger suffix
    name = name.replace('_', ' ').replace('-', ' ').strip()
    return name.title() if name else stem


def _detect_category(rel_path: str) -> str:
    """Detect main category of the LoRA."""
    low = rel_path.lower().replace("\\", "/")
    if "/artist" in low or "artist" in low or "style" in low:
        return "artist"
    if "/chara" in low or "chara" in low or "character" in low:
        return "chara"
    if "/action" in low or "action" in low or "play" in low or "foot" in low or "pose" in low or "cerpe" in low:
        return "action"
    if "/outfit" in low or "outfit" in low or "clothes" in low or "dress" in low or "costume" in low:
        return "outfit"
    if "/turbo" in low or "turbo" in low or "/beauty" in low or "aesthetic" in low:
        return "enhancer"
    if "/repair" in low or "repair" in low or "slider" in low:
        return "repair"
    return "other"


def _category_label(cat: str) -> str:
    labels = {
        "artist": "画师风格",
        "chara": "角色",
        "action": "动作姿态",
        "outfit": "服饰换装",
        "enhancer": "美学加速",
        "repair": "微调修复",
        "other": "其他",
    }
    return labels.get(cat, "其他")


def _detect_arch(rel_path: str) -> str:
    """Detect model architecture (anima, illustrious, flux, other)."""
    low = rel_path.lower()
    if "anima" in low:
        return "anima"
    if "illus" in low or "xl" in low:
        return "illustrious"
    if "flux" in low or "klein" in low or "2real" in low:
        return "flux"
    return "other"


def _detect_group(rel_path: str) -> str:
    """Categorize model into sub-groups for filtering."""
    low = rel_path.lower().replace("\\", "/")
    if "260924" in low:
        return "260924 精选"
    if "/self" in low or "\\self" in low:
        return "自训 (Self)"
    if "2606" in low or "2607" in low:
        return "2606/2607 库"
    if "lycoris" in low:
        return "LyCORIS"
    if "azurlane" in low:
        return "碧蓝航线"
    if "endfield" in low:
        return "终末地"
    if "snowbreak" in low:
        return "尘白禁区"
    if "arknights" in low:
        return "明日方舟"
    if "2real" in low:
        return "2REAL 真人转"
    parts = [p for p in low.split("/") if p]
    if len(parts) >= 2:
        return parts[1]
    return "通用"


class ArtistService:
    """Service for discovering, categorizing, and managing all LoRAs."""

    def __init__(self):
        self._cache: Optional[List[Dict[str, Any]]] = None

    def get_all_artists(self, force_refresh: bool = False, category_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        """Scan and return all LoRAs with previews and metadata."""
        if self._cache is not None and not force_refresh:
            items = self._cache
        else:
            dirs = _get_model_dirs("lora")
            if not dirs:
                return []

            items = []
            seen_paths = set()

            for base_dir in dirs:
                if not base_dir.is_dir():
                    continue

                for root, _, files in os.walk(base_dir):
                    root_path = Path(root)
                    for f in files:
                        ext = os.path.splitext(f)[1].lower()
                        if ext not in {".safetensors", ".ckpt", ".pt"}:
                            continue

                        full_path = root_path / f
                        try:
                            rel_path = str(full_path.relative_to(base_dir)).replace("\\", "/")
                        except ValueError:
                            rel_path = f

                        rel_lower = rel_path.lower()
                        if rel_lower in seen_paths:
                            continue
                        seen_paths.add(rel_lower)

                        stem = full_path.stem
                        parent = full_path.parent
                        category = _detect_category(rel_path)

                        # 1. Preview search (with multiple candidate stems)
                        candidate_stems = [stem]
                        clean_at = re.sub(r'@.*$', '', stem)
                        if clean_at and clean_at not in candidate_stems:
                            candidate_stems.append(clean_at)
                        clean_style = re.sub(r'^(style[-_]|anima[-_]|illus[-_])', '', stem, flags=re.IGNORECASE)
                        if clean_style and clean_style not in candidate_stems:
                            candidate_stems.append(clean_style)

                        preview_file = None
                        for c_stem in candidate_stems:
                            for pext in _PREVIEW_EXTENSIONS:
                                cand = parent / (c_stem + pext)
                                if cand.is_file() and cand.stat().st_size >= 100:
                                    preview_file = cand.name
                                    break
                            if preview_file:
                                break

                        has_preview = preview_file is not None
                        preview_url = f"/api/wfm/models/preview?type=lora&name={rel_path}" if has_preview else None

                        # 2. Trigger / Notrigger sidecar search
                        trig_file = parent / (stem + ".trigger.txt")
                        notrig_file = parent / (stem + ".notrigger.txt")
                        is_notrigger = notrig_file.is_file()
                        has_trigger_file = trig_file.is_file()

                        triggers = []
                        info_text = ""
                        weight_hint = 0.8

                        if is_notrigger:
                            try:
                                info_text = notrig_file.read_text(encoding="utf-8", errors="ignore").strip()
                                m = re.search(r'建议\s*([\d\.]+)~?([\d\.]*)', info_text)
                                if m:
                                    weight_hint = float(m.group(1))
                            except Exception:
                                pass
                        elif has_trigger_file:
                            try:
                                info_text = trig_file.read_text(encoding="utf-8", errors="ignore").strip()
                                lines = [line.strip() for line in info_text.splitlines() if line.strip() and not line.startswith('#')]
                                if lines:
                                    raw_triggers = re.split(r'[,，\n]+', lines[0])
                                    triggers = [t.strip() for t in raw_triggers if t.strip()]
                            except Exception:
                                pass

                        # Fallback trigger detection from filename (e.g. name@trigger.safetensors)
                        if not triggers and not is_notrigger and "@" in stem:
                            match = re.search(r'@([a-zA-Z0-9_\-]+)', stem)
                            if match:
                                triggers = [f"@{match.group(1)}"]

                        display_name = _clean_display_name(stem, category)
                        arch = _detect_arch(rel_path)
                        group = _detect_group(rel_path)
                        win_path = rel_path.replace("/", "\\")

                        cat_name = _category_label(category)
                        toml_snippet = (
                            f"  # {cat_name}：{display_name}{' (无触发词)' if is_notrigger else ''}\n"
                            f"  [[base.loras]]\n"
                            f'  name         = "{display_name}"\n'
                            f"  path         = '{win_path}'\n"
                            f"  model_weight = {weight_hint}\n"
                            f"  clip_weight  = 1.0"
                        )

                        items.append({
                            "id": rel_path,
                            "filename": f,
                            "rel_path": rel_path,
                            "win_path": win_path,
                            "stem": stem,
                            "display_name": display_name,
                            "category": category,
                            "category_label": cat_name,
                            "arch": arch,
                            "group": group,
                            "has_preview": has_preview,
                            "preview_url": preview_url,
                            "is_notrigger": is_notrigger,
                            "triggers": triggers,
                            "primary_trigger": triggers[0] if triggers else "",
                            "weight_hint": weight_hint,
                            "info_text": info_text,
                            "toml_snippet": toml_snippet,
                        })

            # Priority sort: Previews first, then 260924 / Self, then name
            def sort_priority(item):
                prev_score = 0 if item["has_preview"] else 1
                group_score = 0 if "260924" in item["group"] else (1 if "自训" in item["group"] else 2)
                return (prev_score, group_score, item["display_name"].lower())

            items.sort(key=sort_priority)
            self._cache = items

        if category_filter and category_filter != "all":
            return [it for it in items if it["category"] == category_filter]
        return items

    def get_artist_by_path(self, path: str) -> Optional[Dict[str, Any]]:
        norm = path.replace("\\", "/").lower()
        for a in self.get_all_artists():
            if a["rel_path"].lower() == norm or a["win_path"].lower() == norm:
                return a
        return None
