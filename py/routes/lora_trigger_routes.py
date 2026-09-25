"""LoRA trigger matching and management routes."""

import asyncio
import logging
from aiohttp import web

from ..services.lora_trigger_service import LoraTriggerService

logger = logging.getLogger(__name__)

_service = LoraTriggerService()


def setup_routes(app: web.Application):
    """Register LoRA trigger routes."""
    app.router.add_post("/api/wfm/lora/match", handle_match_loras)
    app.router.add_get("/api/wfm/lora/rules", handle_get_rules)
    app.router.add_post("/api/wfm/lora/rules", handle_save_rules)
    app.router.add_post("/api/wfm/lora/rules/rescan", handle_rescan_triggers)
    app.router.add_post("/api/wfm/lora/apply", handle_apply_loras)


async def handle_match_loras(request: web.Request) -> web.Response:
    """POST /api/wfm/lora/match - Match prompt text against trigger rules."""
    try:
        data = await request.json()
        raw_text = data.get("text", "")
        quality_prefix = data.get("quality_prefix", "masterpiece, best quality, aesthetic, highly detailed")
        auto_turbo = data.get("auto_turbo", True)

        # First match in a process pays a full lora-directory walk; keep it off
        # ComfyUI's own event loop so generation progress and WebSockets survive it.
        if _service.needs_scan:
            await asyncio.to_thread(_service.ensure_scanned)

        result = _service.match_text(raw_text, quality_prefix=quality_prefix, auto_turbo=auto_turbo)
        return web.json_response(result)
    except Exception as e:
        logger.error("Error matching LoRAs: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_get_rules(request: web.Request) -> web.Response:
    """GET /api/wfm/lora/rules - Get all configured LoRA rules."""
    try:
        rules = _service.get_rules()
        return web.json_response(rules)
    except Exception as e:
        logger.error("Error getting LoRA rules: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_save_rules(request: web.Request) -> web.Response:
    """POST /api/wfm/lora/rules - Update configured LoRA rules."""
    try:
        rules = await request.json()
        if not isinstance(rules, list):
            return web.json_response({"error": "Rules must be a list"}, status=400)
        saved = _service.save_rules(rules)
        return web.json_response(saved)
    except Exception as e:
        logger.error("Error saving LoRA rules: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_rescan_triggers(request: web.Request) -> web.Response:
    """POST /api/wfm/lora/rules/rescan - Rescan trigger files from lora directories."""
    try:
        scanned = await asyncio.to_thread(_service.scan_trigger_files)
        return web.json_response({
            "message": f"Successfully scanned {len(scanned)} trigger files",
            "count": len(scanned),
            "triggers": scanned
        })
    except Exception as e:
        logger.error("Error rescanning triggers: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_apply_loras(request: web.Request) -> web.Response:
    """POST /api/wfm/lora/apply - Inject matched LoRAs into a workflow."""
    try:
        data = await request.json()
        workflow = data.get("workflow", {})
        active_loras = data.get("loras") or data.get("active_loras") or []
        updated_wf = _service.apply_loras_to_workflow(workflow, active_loras)
        return web.json_response({
            "success": True,
            "applied_count": len(active_loras),
            "workflow": updated_wf
        })
    except Exception as e:
        logger.error("Error applying LoRAs: %s", e)
        return web.json_response({"error": str(e)}, status=500)
