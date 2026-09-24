"""LoRA trigger scanning and multi-LoRA auto-blend service."""

import json
import logging
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any

from ..config import LORA_RULES_FILE
from .models_service import _get_model_dirs

logger = logging.getLogger(__name__)

# Default tuned rules from user tests (multi-LoRA blend + characters + special actions)
_BUILTIN_DEFAULT_RULES = [
    {
        "name": "Liino (梨诺)",
        "path": "anima\\chara\\endfield\\lino_v2.safetensors",
        "model_weight": 1.1,
        "clip_weight": 1.0,
        "triggers": ["liino", "lino"],
        "category": "character"
    },
    {
        "name": "Si (塞希/斯)",
        "path": "anima\\chara\\endfield\\siAnimaTE.safetensors",
        "model_weight": 1.3,
        "clip_weight": 1.0,
        "triggers": ["si \\(arknights\\)", "si (arknights)", "si"],
        "category": "character"
    },
    {
        "name": "Velina / Norma",
        "path": "anima\\chara\\zzz\\Velina，Norma.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["norma", "velina，norma", "velina,norma"],
        "category": "character"
    },
    {
        "name": "Foot Repair (足部修复)",
        "path": "anima\\action\\anima_footRepair_v2-tri-@footRepair.safetensors",
        "model_weight": 0.88,
        "clip_weight": 1.0,
        "triggers": ["foot", "@footrepair", "footjob", "stirrup"],
        "category": "repair"
    },
    {
        "name": "Through Foot (足交穿透)",
        "path": "anima\\action\\footjob\\through\\throughfoot-000052.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["throughfoot", "footjob through"],
        "category": "action"
    },
    {
        "name": "Ustirrup 1500 (镫袜足交主件)",
        "path": "anima\\action\\footjob\\ustirrup\\ustirrup-step00001500.safetensors",
        "model_weight": 1.2,
        "clip_weight": 1.0,
        "triggers": ["ustirrup", "footjob", "under-stirrup footjob"],
        "category": "action"
    },
    {
        "name": "Stirrupjob 50 (镫袜足交强化)",
        "path": "anima\\action\\footjob\\stirrupjob\\stirrupjob-000050.safetensors",
        "model_weight": 1.1,
        "clip_weight": 1.0,
        "triggers": ["stirrupjob", "under-stirrup footjob", "ustirrup", "footjob"],
        "category": "action"
    },
    {
        "name": "Ustirrup 2000 (镫袜足交副调)",
        "path": "anima\\action\\footjob\\ustirrup\\ustirrup-step00002000.safetensors",
        "model_weight": 0.88,
        "clip_weight": 1.0,
        "triggers": ["ustirrup", "under-stirrup footjob"],
        "category": "action"
    },
    {
        "name": "Stirrup 3-1 (镫袜鞋履包裹)",
        "path": "anima\\stirrup3-1(preview0.2).safetensors",
        "model_weight": 0.63,
        "clip_weight": 1.0,
        "triggers": ["stirrup3", "the penis is inside the footwear"],
        "category": "action"
    },
    {
        "name": "Cervical Penetration (深入/子宫口)",
        "path": "anima\\action\\play\\cervical penetration-000032.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["cerpe", "cervical", "cervix"],
        "category": "action"
    },
    {
        "name": "Hairop (发交吞茎)",
        "path": "anima\\action\\hair\\hairop-000026.safetensors",
        "model_weight": 0.8,
        "clip_weight": 1.0,
        "triggers": ["hairop", "hairjob", "hair on penis"],
        "category": "action"
    },
    {
        "name": "Age Slider Old",
        "path": "anima\\action\\age\\age_slider_old-step00000300-1.5.safetensors",
        "model_weight": -0.8,
        "clip_weight": 1.0,
        "triggers": ["age regression", "age down", "age difference"],
        "category": "action"
    },
    {
        "name": "Artist z3zz",
        "path": "anima\\artist\\260613\\anima_z3zz@z3zz.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["@z3zz"],
        "category": "artist"
    },
    {
        "name": "Artist Arikawa Satoru",
        "path": "anima\\artist\\self\\arikawa satoru\\arikawa satoru-000059.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["arikawa style"],
        "category": "artist"
    },
    {
        "name": "Artist Chocostyle",
        "path": "anima\\artist\\self\\@chocostyle\\chocostyle-000024.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["@chocostyle"],
        "category": "artist"
    },
    {
        "name": "Artist Irisstyle",
        "path": "anima\\artist\\self\\@irisstyle\\irisstyle-000025.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["@irisstyle"],
        "category": "artist"
    },
    {
        "name": "Artist Shanyaostyle",
        "path": "anima\\artist\\self\\@shanyaostyle\\shanyaostyle-000024.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["@shanyaostyle"],
        "category": "artist"
    },
    {
        "name": "Artist Loongmstyle",
        "path": "anima\\artist\\self\\@loongmstyle\\loongmstyle-step00001750.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["@loongmstyle"],
        "category": "artist"
    },
    {
        "name": "Artist Kincora",
        "path": "anima\\artist\\260614\\style-Kincora-Anima-v01.safetensors",
        "model_weight": 1.3,
        "clip_weight": 1.0,
        "triggers": ["kincora"],
        "category": "artist"
    },
    {
        "name": "Highres Aesthetic Boost (美学高清提升)",
        "path": "anima\\beauty\\anima-highres-aesthetic-boost.safetensors",
        "model_weight": 0.48,
        "clip_weight": 1.0,
        "triggers": ["aesthetic", "highres", "boost", "aesthetic boost", "quality"],
        "category": "aesthetic"
    },
    {
        "name": "Masterpiece V51 (大师美学修正)",
        "path": "anima\\beauty\\anima-base-1-masterpiece-v51.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["very aesthetic", "masterpiece v51", "quality modifiers"],
        "category": "aesthetic"
    },
    {
        "name": "Solidline Markinson (实体线条强化)",
        "path": "anima\\beauty\\solidline_markinson_anima.safetensors",
        "model_weight": 1.0,
        "clip_weight": 1.0,
        "triggers": ["@solidline", "@markinson", "solidline", "markinson"],
        "category": "aesthetic"
    },
    {
        "name": "Saturation V6 (色彩饱和增强)",
        "path": "anima\\beauty\\saturation_v6.safetensors",
        "model_weight": 0.6,
        "clip_weight": 1.0,
        "triggers": ["saturation", "vivid colors", "color boost"],
        "category": "aesthetic"
    }
]


class LoraTriggerService:
    """Manages trigger detection, multi-LoRA mixtures, and workflow injection."""

    def __init__(self):
        self._rules = self._load_rules()
        self._scanned_triggers = {}  # lora_path -> list of trigger strings

    def _load_rules(self) -> List[Dict[str, Any]]:
        """Load user-defined rules from disk or initialize with defaults."""
        if LORA_RULES_FILE.exists():
            try:
                with open(LORA_RULES_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, list) and len(data) > 0:
                    return data
            except Exception as e:
                logger.warning("Failed to load %s: %s, falling back to builtin", LORA_RULES_FILE, e)

        # Initialize with builtin defaults
        self._save_rules(_BUILTIN_DEFAULT_RULES)
        return list(_BUILTIN_DEFAULT_RULES)

    def _save_rules(self, rules: List[Dict[str, Any]]):
        """Save rules to LORA_RULES_FILE."""
        try:
            LORA_RULES_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(LORA_RULES_FILE, "w", encoding="utf-8") as f:
                json.dump(rules, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error("Failed to save lora rules to %s: %s", LORA_RULES_FILE, e)

    def get_rules(self) -> List[Dict[str, Any]]:
        """Return all active LoRA rules."""
        return self._rules

    def save_rules(self, rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Update and save LoRA rules."""
        self._rules = rules
        self._save_rules(rules)
        return self._rules

    def scan_trigger_files(self) -> Dict[str, List[str]]:
        """Scan all lora directories for *.trigger.txt and companion *.txt files."""
        lora_dirs = _get_model_dirs("lora")
        scanned = {}

        for ldir in lora_dirs:
            if not ldir.is_dir():
                continue
            for root, _, files in os.walk(ldir):
                root_path = Path(root)
                for f in files:
                    if f.endswith(".trigger.txt") or f.endswith(".txt"):
                        txt_path = root_path / f
                        if f.endswith(".trigger.txt"):
                            base_name = f[:-12]  # strip .trigger.txt
                        else:
                            base_name = f[:-4]   # strip .txt

                        # Check if companion model exists
                        safetensors_file = root_path / f"{base_name}.safetensors"
                        if not safetensors_file.exists():
                            # Sometimes trigger file has no .trigger, e.g. foo.trigger.txt where model is foo.safetensors
                            # Check other possible models
                            candidates = list(root_path.glob(f"{base_name}*.safetensors"))
                            if candidates:
                                safetensors_file = candidates[0]
                            else:
                                continue

                        # Calculate relative path from ldir
                        try:
                            rel_path = str(safetensors_file.relative_to(ldir)).replace("/", "\\")
                        except Exception:
                            rel_path = safetensors_file.name

                        # Read trigger words
                        try:
                            triggers = []
                            with open(txt_path, "r", encoding="utf-8", errors="ignore") as tf:
                                for line in tf:
                                    line = line.strip()
                                    if not line or line.startswith("#"):
                                        continue
                                    # Split commas if on single line
                                    for part in line.split(","):
                                        p = part.strip()
                                        if p and p not in triggers:
                                            triggers.append(p)
                            if triggers:
                                scanned[rel_path] = triggers
                        except Exception as e:
                            logger.debug("Error reading %s: %s", txt_path, e)

        self._scanned_triggers = scanned
        logger.info("Scanned %d trigger files from lora directories", len(scanned))
        return scanned

    def match_text(
        self,
        raw_text: str,
        quality_prefix: str = "masterpiece, best quality, aesthetic, highly detailed",
        auto_turbo: bool = True
    ) -> Dict[str, Any]:
        """Parse tags/caption and match active LoRAs with tuned weights."""
        # 1. Parse [tags] and [caption]
        tags_m = re.search(r"\[tags\]\s*(.*?)(?=\[caption\]|$)", raw_text, re.DOTALL | re.IGNORECASE)
        caption_m = re.search(r"\[caption\]\s*(.*?)(?=\[/caption\]|$)", raw_text, re.DOTALL | re.IGNORECASE)

        tags = tags_m.group(1).strip() if tags_m else ""
        caption = caption_m.group(1).strip() if caption_m else ""

        # If [caption] was present but [tags] header was omitted, take preceding text as tags
        if not tags and caption_m:
            before_caption = raw_text[:caption_m.start()].strip()
            if before_caption:
                tags = before_caption

        # If neither [tags] nor [caption] tag found
        if not tags and not caption:
            tags = raw_text.strip()

        # Clean tags and caption
        tags = re.sub(r"^\[tags\]\s*", "", tags, flags=re.IGNORECASE).strip()
        caption = re.sub(r"\[/?caption\]", "", caption, flags=re.IGNORECASE).strip()

        main_prompt = f"{tags}\n\n{caption}".strip() if (tags and caption) else (tags or caption)
        search_text = raw_text.lower()

        # Combine with quality prefix
        combined_positive = f"{quality_prefix}\n\n{main_prompt}".strip() if quality_prefix else main_prompt

        matched_loras = []
        seen_paths = set()

        # Optional turbo LoRA
        if auto_turbo:
            turbo_path = "anima\\turbo\\anima-turbo-lora-v0.2.safetensors"
            matched_loras.append({
                "name": "Turbo-v0.2",
                "path": turbo_path,
                "model_weight": 0.8,
                "clip_weight": 1.0,
                "trigger": "turbo",
                "category": "turbo",
                "active": True
            })
            seen_paths.add(turbo_path.lower())

        # Clean search text for robust fuzzy keyword matching
        cleaned_search = re.sub(r"[\\()@,_]", " ", search_text)

        # 2. Check user-defined rules (highest priority, retains multi-LoRA blend & exact weights)
        matched_rule_triggers = set()
        for rule in self._rules:
            path = rule.get("path", "")
            if not path or path.lower() in seen_paths:
                continue

            triggers = rule.get("triggers", [])
            hit_trigger = None
            for trig in triggers:
                t_lower = trig.lower().strip()
                if not t_lower:
                    continue
                # Exact in search_text
                if t_lower in search_text:
                    hit_trigger = trig
                    break
                # Stripped in cleaned_search
                clean_trig = re.sub(r"[\\()@,_]", " ", t_lower).strip()
                if clean_trig and clean_trig in cleaned_search:
                    hit_trigger = trig
                    break

            if hit_trigger:
                matched_loras.append({
                    "name": rule.get("name", Path(path).stem),
                    "path": path,
                    "model_weight": float(rule.get("model_weight", 1.0)),
                    "clip_weight": float(rule.get("clip_weight", 1.0)),
                    "trigger": hit_trigger,
                    "category": rule.get("category", "custom"),
                    "active": True
                })
                seen_paths.add(path.lower())
                matched_rule_triggers.add(hit_trigger.lower())

        # 3. Check scanned .trigger.txt files for any additional unconfigured LoRAs
        if not self._scanned_triggers:
            self.scan_trigger_files()

        for path, triggers in self._scanned_triggers.items():
            if path.lower() in seen_paths:
                continue
            hit_trigger = None
            for trig in triggers:
                t_lower = trig.lower().strip()
                if not t_lower:
                    continue
                if t_lower in search_text:
                    hit_trigger = trig
                    break
                clean_trig = re.sub(r"[\\()@,_]", " ", t_lower).strip()
                if clean_trig and clean_trig in cleaned_search:
                    hit_trigger = trig
                    break

            if hit_trigger:
                is_covered = hit_trigger.lower() in matched_rule_triggers
                matched_loras.append({
                    "name": Path(path).stem,
                    "path": path,
                    "model_weight": 1.0,
                    "clip_weight": 1.0,
                    "trigger": hit_trigger,
                    "category": "auto-scanned",
                    "active": not is_covered
                })
                seen_paths.add(path.lower())

        return {
            "matched_loras": matched_loras,
            "parsed_prompt": {
                "tags": tags,
                "caption": caption,
                "positive_prompt": combined_positive,
                "raw": raw_text
            }
        }

    def apply_loras_to_workflow(
        self,
        workflow: Dict[str, Any],
        active_loras: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Apply active LoRAs with independent weights into the workflow."""
        wf = dict(workflow)
        enabled_loras = [l for l in active_loras if l.get("active", True)]
        if not enabled_loras:
            return wf

        # Check if UI format workflow (contains top-level 'nodes' array)
        if isinstance(wf, dict) and "nodes" in wf and isinstance(wf["nodes"], list):
            for n in wf["nodes"]:
                if n.get("type") == "CR LoRA Stack":
                    widgets = []
                    for slot in range(3):
                        if slot < len(enabled_loras):
                            item = enabled_loras[slot]
                            widgets.extend([
                                "On",
                                item["path"].replace("/", "\\"),
                                float(item["model_weight"]),
                                float(item["clip_weight"])
                            ])
                        else:
                            widgets.extend(["Off", "None", 1.0, 1.0])
                    n["widgets_values"] = widgets
                    n["mode"] = 0
                elif n.get("type") == "CR Apply LoRA Stack":
                    n["mode"] = 0
            return wf

        # Check for CR LoRA Stack pattern in API-format workflow
        cr_stack_ids = [nid for nid, n in wf.items() if isinstance(n, dict) and n.get("class_type") == "CR LoRA Stack"]
        cr_apply_ids = [nid for nid, n in wf.items() if isinstance(n, dict) and n.get("class_type") == "CR Apply LoRA Stack"]

        if cr_stack_ids and cr_apply_ids:
            # Distribute into CR LoRA Stack nodes (in chunks of 3)
            # Find base stack node and downstream apply node
            apply_node = wf[cr_apply_ids[0]]
            prev_stack_id = None
            base_id = int(cr_stack_ids[0])

            # Prepare stack nodes with collision-free IDs
            num_stacks_needed = (len(enabled_loras) + 2) // 3
            existing_int_ids = []
            for k in wf.keys():
                try:
                    existing_int_ids.append(int(k))
                except (ValueError, TypeError):
                    pass
            next_available_id = (max(existing_int_ids) + 1) if existing_int_ids else 9000

            for s_idx in range(num_stacks_needed):
                chunk = enabled_loras[s_idx * 3 : (s_idx + 1) * 3]
                if s_idx == 0:
                    node_id_str = str(base_id)
                else:
                    node_id_str = str(next_available_id)
                    next_available_id += 1

                inputs: Dict[str, Any] = {}
                if prev_stack_id is not None:
                    inputs["lora_stack"] = [str(prev_stack_id), 0]

                for slot in range(1, 4):
                    if slot - 1 < len(chunk):
                        item = chunk[slot - 1]
                        inputs[f"switch_{slot}"] = "On"
                        inputs[f"lora_name_{slot}"] = item["path"].replace("/", "\\")
                        inputs[f"model_weight_{slot}"] = float(item["model_weight"])
                        inputs[f"clip_weight_{slot}"] = float(item["clip_weight"])
                    else:
                        inputs[f"switch_{slot}"] = "Off"
                        inputs[f"lora_name_{slot}"] = "None"
                        inputs[f"model_weight_{slot}"] = 1.0
                        inputs[f"clip_weight_{slot}"] = 1.0

                wf[node_id_str] = {
                    "class_type": "CR LoRA Stack",
                    "inputs": inputs,
                    "_meta": {"title": f"CR LoRA Stack {s_idx + 1}"}
                }
                prev_stack_id = node_id_str

            # Connect final stack to CR Apply LoRA Stack
            apply_node["inputs"]["lora_stack"] = [str(prev_stack_id), 0]
            logger.info("Injected %d LoRAs across %d CR LoRA Stack nodes", len(enabled_loras), num_stacks_needed)
            return wf

        # Check for Power Lora Loader (rgthree)
        rg_ids = [nid for nid, n in wf.items() if n.get("class_type") == "Power Lora Loader (rgthree)"]
        if rg_ids:
            rg_node = wf[rg_ids[0]]
            inputs = rg_node.setdefault("inputs", {})
            for idx, item in enumerate(enabled_loras, start=1):
                inputs[f"lora_{idx}"] = item["path"].replace("/", "\\")
                inputs[f"strength_{idx}"] = float(item["model_weight"])
                inputs[f"strength_clip_{idx}"] = float(item["clip_weight"])
            logger.info("Injected %d LoRAs into Power Lora Loader", len(enabled_loras))
            return wf

        # Check for Lora Loader (LoraManager)
        lm_ids = [nid for nid, n in wf.items() if n.get("class_type") == "Lora Loader (LoraManager)"]
        if lm_ids:
            lm_node = wf[lm_ids[0]]
            inputs = lm_node.setdefault("inputs", {})
            loras_val = []
            for item in enabled_loras:
                loras_val.append({
                    "name": Path(item["path"]).stem,
                    "strength": float(item["model_weight"]),
                    "clipStrength": float(item["clip_weight"]),
                    "active": True
                })
            inputs["loras"] = {"__value__": loras_val}
            logger.info("Injected %d LoRAs into LoraManager", len(enabled_loras))
            return wf

        # Single LoraLoader fallback
        ll_ids = [nid for nid, n in wf.items() if n.get("class_type") in ("LoraLoader", "LoraLoaderModelOnly")]
        if ll_ids:
            ll_node = wf[ll_ids[0]]
            item = enabled_loras[0]
            ll_node["inputs"]["lora_name"] = item["path"].replace("/", "\\")
            ll_node["inputs"]["strength_model"] = float(item["model_weight"])
            if "strength_clip" in ll_node["inputs"]:
                ll_node["inputs"]["strength_clip"] = float(item["clip_weight"])
            logger.info("Injected top LoRA %s into LoraLoader", item["path"])
            return wf

        logger.warning("No supported LoRA loader found in workflow to inject matched LoRAs")
        return wf
