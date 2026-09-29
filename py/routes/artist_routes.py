"""API routes for Artist & Style LoRA selection and management."""

import asyncio
import logging
import os
import re
from pathlib import Path
from aiohttp import web

from ..services.artist_service import ArtistService

logger = logging.getLogger(__name__)

_service = ArtistService()


def setup_routes(app: web.Application):
    """Register artist API routes."""
    app.router.add_get("/api/wfm/artists", handle_get_artists)
    app.router.add_get("/api/wfm/artists/detail", handle_get_artist_detail)
    app.router.add_post("/api/wfm/artists/apply-to-batch", handle_apply_to_batch)


async def handle_get_artists(request: web.Request) -> web.Response:
    """GET /api/wfm/artists?refresh=true&arch=anima

    Returns list of discovered artist LoRAs, preview info, triggers, and stats.
    """
    refresh = request.query.get("refresh", "").lower() in ("true", "1")
    category_filter = request.query.get("category", "").lower()
    arch_filter = request.query.get("arch", "").lower()
    group_filter = request.query.get("group", "")
    has_preview_filter = request.query.get("has_preview", "").lower() in ("true", "1")

    try:
        artists = await asyncio.to_thread(_service.get_all_artists, refresh)

        filtered = artists
        if category_filter and category_filter != "all":
            filtered = [a for a in filtered if a.get("category", "") == category_filter]
        if arch_filter and arch_filter != "all":
            filtered = [a for a in filtered if a["arch"].lower() == arch_filter]
        if group_filter and group_filter != "all":
            filtered = [a for a in filtered if a["group"] == group_filter]
        if has_preview_filter:
            filtered = [a for a in filtered if a["has_preview"]]

        # Statistics
        category_counts = {}
        for a in artists:
            c = a.get("category", "other")
            category_counts[c] = category_counts.get(c, 0) + 1

        stats = {
            "total": len(artists),
            "with_preview": sum(1 for a in artists if a["has_preview"]),
            "categories": category_counts,
            "groups": sorted(list({a["group"] for a in artists})),
            "archs": sorted(list({a["arch"] for a in artists})),
        }

        return web.json_response({
            "status": "ok",
            "stats": stats,
            "count": len(filtered),
            "artists": filtered,
        })
    except Exception as e:
        logger.error("Error retrieving artists: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_get_artist_detail(request: web.Request) -> web.Response:
    """GET /api/wfm/artists/detail?path=..."""
    path = request.query.get("path", "")
    if not path:
        return web.json_response({"error": "path is required"}, status=400)

    try:
        artist = await asyncio.to_thread(_service.get_artist_by_path, path)
        if not artist:
            return web.json_response({"error": "Artist not found"}, status=404)
        return web.json_response({"status": "ok", "artist": artist})
    except Exception as e:
        logger.error("Error retrieving artist detail: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_apply_to_batch(request: web.Request) -> web.Response:
    """POST /api/wfm/artists/apply-to-batch

    Body:
    {
      "toml_path": "/path/to/batch.toml" or "碧蓝航线_拉菲II",
      "artist_path": "anima\\artist\\260924\\@freng.safetensors",
      "model_weight": 0.8,
      "clip_weight": 1.0,
      "name": "Freng"
    }
    """
    try:
        data = await request.json()
        toml_target = data.get("toml_path", "").strip()
        artist_path = data.get("artist_path", "").strip()
        weight = float(data.get("model_weight", 0.8))
        clip_weight = float(data.get("clip_weight", 1.0))
        name = data.get("name", "").strip()

        if not toml_target or not artist_path:
            return web.json_response({"error": "toml_path and artist_path are required"}, status=400)

        # Resolve toml path
        target_path = Path(toml_target)
        if not target_path.is_file():
            # Try searching in standard storyboard directory
            wild_base = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard")
            cand1 = wild_base / toml_target / "batch.toml"
            cand2 = wild_base / toml_target
            if cand1.is_file():
                target_path = cand1
            elif cand2.is_file():
                target_path = cand2
            else:
                return web.json_response({"error": f"Cannot find batch.toml at: {toml_target}"}, status=404)

        content = target_path.read_text(encoding="utf-8")

        # Win path format
        win_artist_path = artist_path.replace("/", "\\")
        if not name:
            name = Path(win_artist_path).stem

        # Look for existing artist block in [[base.loras]]
        # Pattern matches [[base.loras]] block containing 'artist' or previously configured artist
        artist_block_re = re.compile(
            r'(\s*#\s*画师[^\n]*\n)?\s*\[\[base\.loras\]\]\s*\n\s*name\s*=\s*"[^"]*"\s*\n\s*path\s*=\s*[\'"][^\'"]*artist[^\'"]*[\'"][^\n]*\n\s*model_weight\s*=\s*[\d\.]+\s*\n\s*clip_weight\s*=\s*[\d\.]+',
            re.MULTILINE
        )

        replacement = (
            f"  # 画师：{name}\n"
            f"  [[base.loras]]\n"
            f'  name         = "{name}"\n'
            f"  path         = '{win_artist_path}'\n"
            f"  model_weight = {weight}\n"
            f"  clip_weight  = {clip_weight}"
        )

        new_content, count = artist_block_re.subn(replacement, content, count=1)
        if count == 0:
            # Fallback: find any Kaede Sayappa or Oyari Ashito or replace the 3rd lora in base.loras
            fallback_re = re.compile(
                r'(\s*#\s*画师[^\n]*\n)?\s*\[\[base\.loras\]\]\s*\n\s*name\s*=\s*"(?:Kaede Sayappa|Oyari Ashito|.*Artist.*)"[^\n]*\n\s*path\s*=\s*[\'"][^\'"]+[\'"][^\n]*\n\s*model_weight\s*=\s*[\d\.]+\s*\n\s*clip_weight\s*=\s*[\d\.]+',
                re.MULTILINE
            )
            new_content, count = fallback_re.subn(replacement, content, count=1)

        if count == 0:
            return web.json_response({
                "error": "Could not identify an existing artist [[base.loras]] block to replace. Please check batch.toml structure."
            }, status=422)

        # Backup old file
        backup_file = target_path.with_suffix(".toml.bak")
        target_path.write_text(new_content, encoding="utf-8")

        return web.json_response({
            "status": "ok",
            "message": f"Successfully updated artist in {target_path.name}",
            "toml_path": str(target_path),
            "updated_artist": {
                "name": name,
                "path": win_artist_path,
                "model_weight": weight,
                "clip_weight": clip_weight,
            }
        })
    except Exception as e:
        logger.error("Error applying artist to batch: %s", e)
        return web.json_response({"error": str(e)}, status=500)
