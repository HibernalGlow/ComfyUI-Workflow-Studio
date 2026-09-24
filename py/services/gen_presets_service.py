"""Generation & Sampler Presets Service.
Allows saving, loading, and applying complete confirmed generation setups (single/double sampling,
steps, cfg, samplers, schedulers, and LoRA mixtures) with one click.
"""

import os
import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional

from ..config import GEN_PRESETS_FILE
from .lora_trigger_service import LoraTriggerService

logger = logging.getLogger(__name__)

_DEFAULT_GEN_PRESETS: List[Dict[str, Any]] = [
    {
        "id": "anima-single-turbo",
        "name": "⚡ Anima 单采样极速 (Turbo 12步)",
        "description": "单采样出图，12步 + CFG 1.6 + euler_ancestral + beta57。开启 Turbo 0.8 与高画质提升 0.48，出图极快且细节锐利。",
        "workflow": "animanga-liino-clean.json",
        "sampling_mode": "single",
        "sampler_settings": {
            "steps": 12,
            "cfg": 1.6,
            "sampler_name": "euler_ancestral",
            "scheduler": "beta57",
            "denoise": 1.0
        },
        "loras": [
            {
                "name": "Turbo-v0.2",
                "path": "anima\\turbo\\anima-turbo-lora-v0.2.safetensors",
                "model_weight": 0.8,
                "clip_weight": 1.0,
                "active": True
            },
            {
                "name": "Highres Aesthetic Boost (美学高清提升)",
                "path": "anima\\beauty\\anima-highres-aesthetic-boost.safetensors",
                "model_weight": 0.48,
                "clip_weight": 1.0,
                "active": True
            }
        ],
        "quality_prefix": "masterpiece, best quality, aesthetic, highly detailed",
        "default_negative": "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits"
    },
    {
        "id": "anima-two-stage-standard",
        "name": "🎭 Anima 双层精细采样 (5步粗采 + 12步精修)",
        "description": "双层采样模式，Stage 1 (5步 CFG 4.6 er_sde) 确立人体骨架，Stage 2 (12步 CFG 1.6 beta57) 结合 LoRA 高精度精修。",
        "workflow": "animanga-liino-clean.json",
        "sampling_mode": "double",
        "sampler_stage1": {
            "steps": 5,
            "cfg": 4.6,
            "sampler_name": "er_sde",
            "scheduler": "simple",
            "denoise": 1.0
        },
        "sampler_stage2": {
            "steps": 12,
            "cfg": 1.6,
            "sampler_name": "dpmpp_2m_sde_gpu",
            "scheduler": "beta57",
            "denoise": 1.0
        },
        "loras": [
            {
                "name": "Turbo-v0.2",
                "path": "anima\\turbo\\anima-turbo-lora-v0.2.safetensors",
                "model_weight": 0.8,
                "clip_weight": 1.0,
                "active": True
            },
            {
                "name": "Highres Aesthetic Boost (美学高清提升)",
                "path": "anima\\beauty\\anima-highres-aesthetic-boost.safetensors",
                "model_weight": 0.48,
                "clip_weight": 1.0,
                "active": True
            }
        ],
        "quality_prefix": "masterpiece, best quality, aesthetic, highly detailed",
        "default_negative": "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits"
    },
    {
        "id": "anima-native-30",
        "name": "🎨 Anima 原生全扩散 (30步 er_sde / 无Turbo)",
        "description": "传统完整扩散去噪，30步 + CFG 4.0 + er_sde + beta57，纯原生 Anima 风格，画风厚重细腻。",
        "workflow": "Anima正式版-文生图工作流.json",
        "sampling_mode": "single",
        "sampler_settings": {
            "steps": 30,
            "cfg": 4.0,
            "sampler_name": "er_sde",
            "scheduler": "beta57",
            "denoise": 1.0
        },
        "loras": [
            {
                "name": "Highres Aesthetic Boost (美学高清提升)",
                "path": "anima\\beauty\\anima-highres-aesthetic-boost.safetensors",
                "model_weight": 0.48,
                "clip_weight": 1.0,
                "active": True
            }
        ],
        "quality_prefix": "masterpiece, best quality, aesthetic, highly detailed",
        "default_negative": "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits"
    },
    {
        "id": "liino-footjob-suite",
        "name": "🦶 梨诺镫袜足交全套混合 (6 LoRA 精调)",
        "description": "经过反复测试验证的全套足交混合配方：梨诺 1.1 + 足部修复 0.88 + 镫袜主件 1.2 + 强化件 1.1 + 副调件 0.88 + 鞋履包裹 0.63 + Turbo 0.8。",
        "workflow": "animanga-liino-clean.json",
        "sampling_mode": "single",
        "sampler_settings": {
            "steps": 12,
            "cfg": 1.6,
            "sampler_name": "euler_ancestral",
            "scheduler": "beta57",
            "denoise": 1.0
        },
        "loras": [
            { "name": "Turbo-v0.2", "path": "anima\\turbo\\anima-turbo-lora-v0.2.safetensors", "model_weight": 0.8, "clip_weight": 1.0, "active": True },
            { "name": "Liino (梨诺)", "path": "anima\\chara\\endfield\\lino_v2.safetensors", "model_weight": 1.1, "clip_weight": 1.0, "active": True },
            { "name": "Foot Repair (足部修复)", "path": "anima\\action\\anima_footRepair_v2-tri-@footRepair.safetensors", "model_weight": 0.88, "clip_weight": 1.0, "active": True },
            { "name": "Ustirrup 1500 (镫袜足交主件)", "path": "anima\\action\\footjob\\ustirrup\\ustirrup-step00001500.safetensors", "model_weight": 1.2, "clip_weight": 1.0, "active": True },
            { "name": "Stirrupjob 50 (镫袜足交强化)", "path": "anima\\action\\footjob\\stirrupjob\\stirrupjob-000050.safetensors", "model_weight": 1.1, "clip_weight": 1.0, "active": True },
            { "name": "Ustirrup 2000 (镫袜足交副调)", "path": "anima\\action\\footjob\\ustirrup\\ustirrup-step00002000.safetensors", "model_weight": 0.88, "clip_weight": 1.0, "active": True },
            { "name": "Stirrup 3-1 (镫袜鞋履包裹)", "path": "anima\\stirrup3-1(preview0.2).safetensors", "model_weight": 0.63, "clip_weight": 1.0, "active": True },
            { "name": "Highres Aesthetic Boost (美学高清提升)", "path": "anima\\beauty\\anima-highres-aesthetic-boost.safetensors", "model_weight": 0.48, "clip_weight": 1.0, "active": True }
        ],
        "quality_prefix": "masterpiece, best quality, aesthetic, highly detailed",
        "default_negative": "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits"
    }
]


class GenPresetsService:
    """Manages generation/workflow presets and applies them directly to workflows."""

    def __init__(self):
        self._lora_service = LoraTriggerService()
        self._presets = self._load_presets()

    def _load_presets(self) -> List[Dict[str, Any]]:
        if GEN_PRESETS_FILE.exists():
            try:
                with open(GEN_PRESETS_FILE, "r", encoding="utf-8") as f:
                    presets = json.load(f)
                    if isinstance(presets, list) and presets:
                        return presets
            except Exception as e:
                logger.error("Failed to read %s: %s", GEN_PRESETS_FILE, e)

        # Fallback to default presets and persist
        self._save_presets(_DEFAULT_GEN_PRESETS)
        return _DEFAULT_GEN_PRESETS

    def _save_presets(self, presets: List[Dict[str, Any]]):
        try:
            GEN_PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(GEN_PRESETS_FILE, "w", encoding="utf-8") as f:
                json.dump(presets, f, indent=2, ensure_ascii=False)
            logger.info("Saved %d presets to %s", len(presets), GEN_PRESETS_FILE)
        except Exception as e:
            logger.error("Failed to write to %s: %s", GEN_PRESETS_FILE, e)

    def get_presets(self) -> List[Dict[str, Any]]:
        return self._presets

    def get_preset_by_id(self, preset_id: str) -> Optional[Dict[str, Any]]:
        for p in self._presets:
            if p.get("id") == preset_id:
                return p
        return None

    def save_preset(self, preset_data: Dict[str, Any]) -> Dict[str, Any]:
        preset_id = preset_data.get("id")
        if not preset_id:
            import uuid
            preset_id = f"preset-{uuid.uuid4().hex[:8]}"
            preset_data["id"] = preset_id

        # Update or insert
        updated = False
        for idx, p in enumerate(self._presets):
            if p.get("id") == preset_id:
                self._presets[idx] = preset_data
                updated = True
                break

        if not updated:
            self._presets.append(preset_data)

        self._save_presets(self._presets)
        return preset_data

    def delete_preset(self, preset_id: str) -> bool:
        initial_len = len(self._presets)
        self._presets = [p for p in self._presets if p.get("id") != preset_id]
        if len(self._presets) < initial_len:
            self._save_presets(self._presets)
            return True
        return False

    def apply_preset_to_workflow(self, workflow: Dict[str, Any], preset: Dict[str, Any]) -> Dict[str, Any]:
        """Apply preset parameters (single/double sampling, steps, cfg, LoRAs) directly to a workflow."""
        wf = dict(workflow)
        sampling_mode = preset.get("sampling_mode", "single")

        # 1. Check if workflow is UI format (has 'nodes' array)
        if isinstance(wf, dict) and "nodes" in wf and isinstance(wf["nodes"], list):
            stage1_node = None
            stage2_node = None
            for n in wf["nodes"]:
                nid = n.get("id")
                ntype = n.get("type", "")
                if nid == 836 or "FLS_Sampler" in ntype or "KSampler" in ntype:
                    if stage1_node is None:
                        stage1_node = n
                    else:
                        stage2_node = n

            # Single mode: bypass stage 1, apply settings to stage 2
            if sampling_mode == "single":
                settings = preset.get("sampler_settings", {})
                target_node = stage2_node or stage1_node
                if target_node:
                    target_node["mode"] = 0
                    widgets = target_node.get("widgets_values", [])
                    # [seed, randomize, steps, cfg, sampler_name, scheduler, denoise, ...]
                    if len(widgets) >= 7:
                        widgets[2] = int(settings.get("steps", 12))
                        widgets[3] = float(settings.get("cfg", 1.6))
                        widgets[4] = str(settings.get("sampler_name", "euler_ancestral"))
                        widgets[5] = str(settings.get("scheduler", "beta57"))
                        widgets[6] = float(settings.get("denoise", 1.0))
                if stage1_node and stage2_node:
                    stage1_node["mode"] = 4  # Bypass stage 1
            else:
                # Double mode: enable both stage 1 and stage 2
                s1 = preset.get("sampler_stage1", {})
                s2 = preset.get("sampler_stage2", {})
                if stage1_node:
                    stage1_node["mode"] = 0
                    w1 = stage1_node.get("widgets_values", [])
                    if len(w1) >= 7:
                        w1[2] = int(s1.get("steps", 5))
                        w1[3] = float(s1.get("cfg", 4.6))
                        w1[4] = str(s1.get("sampler_name", "er_sde"))
                        w1[5] = str(s1.get("scheduler", "simple"))
                if stage2_node:
                    stage2_node["mode"] = 0
                    w2 = stage2_node.get("widgets_values", [])
                    if len(w2) >= 7:
                        w2[2] = int(s2.get("steps", 12))
                        w2[3] = float(s2.get("cfg", 1.6))
                        w2[4] = str(s2.get("sampler_name", "dpmpp_2m_sde_gpu"))
                        w2[5] = str(s2.get("scheduler", "beta57"))

        # 2. Check if workflow is API format (dict of node ID -> node dict)
        elif isinstance(wf, dict):
            stage1_node = wf.get("836")
            stage2_node = wf.get("724")

            # Fallback to any KSampler nodes if 836/724 not found
            if not stage2_node:
                samplers = [n for nid, n in wf.items() if isinstance(n, dict) and "Sampler" in n.get("class_type", "")]
                if samplers:
                    stage2_node = samplers[-1]
                    if len(samplers) > 1:
                        stage1_node = samplers[0]

            if sampling_mode == "single":
                settings = preset.get("sampler_settings", {})
                target = stage2_node or stage1_node
                if target:
                    inputs = target.setdefault("inputs", {})
                    inputs["steps"] = int(settings.get("steps", 12))
                    inputs["cfg"] = float(settings.get("cfg", 1.6))
                    inputs["sampler_name"] = str(settings.get("sampler_name", "euler_ancestral"))
                    inputs["scheduler"] = str(settings.get("scheduler", "beta57"))
                    # Link latent directly from upstream source of stage 1
                    if stage1_node and isinstance(stage1_node, dict) and "inputs" in stage1_node and "latent_image" in stage1_node["inputs"]:
                        inputs["latent_image"] = stage1_node["inputs"]["latent_image"]
                    elif "456" in wf:
                        inputs["latent_image"] = ["456", 0]
            else:
                # Double sampling mode
                s1 = preset.get("sampler_stage1", {})
                s2 = preset.get("sampler_stage2", {})
                if stage1_node:
                    i1 = stage1_node.setdefault("inputs", {})
                    i1["steps"] = int(s1.get("steps", 5))
                    i1["cfg"] = float(s1.get("cfg", 4.6))
                    i1["sampler_name"] = str(s1.get("sampler_name", "er_sde"))
                    i1["scheduler"] = str(s1.get("scheduler", "simple"))
                if stage2_node:
                    i2 = stage2_node.setdefault("inputs", {})
                    i2["steps"] = int(s2.get("steps", 12))
                    i2["cfg"] = float(s2.get("cfg", 1.6))
                    i2["sampler_name"] = str(s2.get("sampler_name", "dpmpp_2m_sde_gpu"))
                    i2["scheduler"] = str(s2.get("scheduler", "beta57"))
                    if stage1_node:
                        i2["latent_image"] = ["836", 0]

        # 3. Apply preset LoRAs if defined
        preset_loras = preset.get("loras", [])
        if preset_loras:
            wf = self._lora_service.apply_loras_to_workflow(wf, preset_loras)

        logger.info("Successfully applied preset '%s' (%s) to workflow", preset.get("name"), sampling_mode)
        return wf
