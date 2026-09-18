"""Video tab Edit subtab project file management (JSON timeline persistence).

Same CRUD shape as VideoPlanService (list/get/save/delete with a safe-path
helper), kept as its own class rather than sharing a base because the two
JSON schemas are unrelated (batch keyframe blocks vs. an ordered clip
timeline) — see VideoPlanService's own docstring for the same reasoning.
No index-image thumbnail support (unlike VideoPlanService) since the Edit
project list is plain text/JSON only for now.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


class VideoEditProjectService:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir
        self.project_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Path safety
    # ------------------------------------------------------------------

    def _safe_path(self, filename: str, ext: str = ".json") -> Path | None:
        if not filename or not filename.strip():
            return None
        name = filename.strip()
        if not name.endswith(ext):
            name = name + ext
        if "/" in name or "\\" in name or name in (".", "..") or "\x00" in name:
            return None
        resolved = (self.project_dir / name).resolve()
        project_dir_resolved = self.project_dir.resolve()
        if resolved != project_dir_resolved and not str(resolved).startswith(str(project_dir_resolved) + "\\") and not str(resolved).startswith(str(project_dir_resolved) + "/"):
            return None
        return resolved

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def list_projects(self) -> list[dict]:
        if not self.project_dir.is_dir():
            return []
        result = []
        for path in sorted(self.project_dir.glob("*.json")):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                logger.warning("Skipping unreadable video edit project %s: %s", path.name, e)
                continue

            result.append({
                "filename": path.name,
                "name": data.get("name", path.stem),
                "clip_count": len(data.get("clips", [])),
                "updated_at": data.get("updated_at", ""),
            })
        result.sort(key=lambda p: p.get("updated_at", ""), reverse=True)
        return result

    def get_project(self, filename: str) -> dict:
        path = self._safe_path(filename)
        if path is None:
            raise ValueError(f"Invalid filename: {filename}")
        if not path.is_file():
            raise FileNotFoundError(f"Project not found: {filename}")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_project(self, filename: str, data: dict) -> dict:
        path = self._safe_path(filename)
        if path is None:
            raise ValueError(f"Invalid filename: {filename}")

        data = dict(data)
        data["updated_at"] = self._now_iso()

        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        return {"filename": path.name, "updated_at": data["updated_at"]}

    def delete_project(self, filename: str) -> None:
        path = self._safe_path(filename)
        if path is None:
            raise ValueError(f"Invalid filename: {filename}")
        if path.is_file():
            path.unlink()
