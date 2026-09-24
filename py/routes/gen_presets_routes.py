"""Generation & Sampler Presets API Routes."""

import logging
from aiohttp import web
from ..services.gen_presets_service import GenPresetsService

logger = logging.getLogger(__name__)

_service = GenPresetsService()


def setup_routes(app: web.Application):
    """Register Generation Preset routes."""
    app.router.add_get("/api/wfm/gen_presets", handle_get_presets)
    app.router.add_post("/api/wfm/gen_presets", handle_save_preset)
    app.router.add_post("/api/wfm/gen_presets/apply", handle_apply_preset)
    app.router.add_delete("/api/wfm/gen_presets/{id}", handle_delete_preset)


async def handle_get_presets(request: web.Request) -> web.Response:
    """GET /api/wfm/gen_presets - List all presets."""
    try:
        presets = _service.get_presets()
        return web.json_response(presets)
    except Exception as e:
        logger.error("Error getting gen presets: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_save_preset(request: web.Request) -> web.Response:
    """POST /api/wfm/gen_presets - Create or update a preset."""
    try:
        data = await request.json()
        saved = _service.save_preset(data)
        return web.json_response({"status": "ok", "preset": saved})
    except Exception as e:
        logger.error("Error saving gen preset: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_apply_preset(request: web.Request) -> web.Response:
    """POST /api/wfm/gen_presets/apply - Apply a preset to a workflow."""
    try:
        data = await request.json()
        workflow = data.get("workflow", {})
        preset = data.get("preset")

        if not preset and "preset_id" in data:
            preset = _service.get_preset_by_id(data["preset_id"])

        if not preset:
            return web.json_response({"error": "Preset not found or provided"}, status=400)

        updated_wf = _service.apply_preset_to_workflow(workflow, preset)
        return web.json_response({
            "status": "ok",
            "preset": preset,
            "workflow": updated_wf
        })
    except Exception as e:
        logger.error("Error applying gen preset: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_delete_preset(request: web.Request) -> web.Response:
    """DELETE /api/wfm/gen_presets/{id} - Delete a preset."""
    try:
        preset_id = request.match_info.get("id")
        if not preset_id:
            return web.json_response({"error": "Missing preset id"}, status=400)
        success = _service.delete_preset(preset_id)
        return web.json_response({"status": "ok", "deleted": success})
    except Exception as e:
        logger.error("Error deleting gen preset: %s", e)
        return web.json_response({"error": str(e)}, status=500)
