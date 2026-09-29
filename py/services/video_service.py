"""Video tab utilities: last-frame capture and animated GIF conversion.

Runs entirely on dependencies ComfyUI itself already requires — PyAV for
decoding (ComfyUI core already needs av>=17.0.0) and Pillow for GIF encoding
— so no ffmpeg binary and no new pip installs, unlike a typical ffmpeg-based
implementation (e.g. Eagle's video2gif/video-to-frame plugins).
"""

import base64
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    from PIL import Image
    _RESAMPLE = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
except Exception:  # pragma: no cover - Pillow is a hard ComfyUI dependency
    _RESAMPLE = None

# Text overlay anchors: 9-grid "<vertical>-<horizontal>" (e.g. "bottom-center").
_ANCHOR_V = ("top", "middle", "bottom")
_ANCHOR_H = ("left", "center", "right")

# Fonts tried in order for text overlays. Pillow's built-in default font has no
# CJK glyphs (Japanese/Chinese text would render as boxes), so a system font
# with CJK coverage is preferred; load_default() is only the last resort.
_FONT_CANDIDATES = {
    "win32": ["meiryo.ttc", "YuGothM.ttc", "NotoSansJP-Regular.ttf", "msgothic.ttc", "arial.ttf"],
    "darwin": [
        "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ],
    "linux": [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
}


def _load_overlay_font(size: int):
    from PIL import ImageFont

    platform = "win32" if sys.platform.startswith("win") else ("darwin" if sys.platform == "darwin" else "linux")
    for name in _FONT_CANDIDATES[platform]:
        path = name
        if platform == "win32" and not os.path.isabs(name):
            path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default(size=size)


def _render_text_layer(width: int, height: int, ov: dict):
    """Renders one overlay's text onto a transparent full-frame RGBA layer, so
    it can be alpha-composited over every frame in its time range without
    re-rendering the text per frame (same idea as ComfyUI core's TextOverlay)."""
    from PIL import ImageColor, ImageDraw

    text = str(ov.get("text") or "").replace("\\n", "\n")
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    if not text.strip():
        return layer

    size = max(8, round(float(ov.get("font_size") or 6.0) / 100.0 * height))
    font = _load_overlay_font(size)
    stroke = max(1, round(size * 0.06)) if ov.get("outline", True) else 0
    spacing = round(size * 0.2)
    try:
        color = ImageColor.getrgb(str(ov.get("color") or "#ffffff"))
    except ValueError:
        color = (255, 255, 255)
    fill = (*color[:3], 255)

    anchor = str(ov.get("anchor") or "bottom-center").split("-")
    v = anchor[0] if anchor and anchor[0] in _ANCHOR_V else "bottom"
    h = anchor[1] if len(anchor) > 1 and anchor[1] in _ANCHOR_H else "center"

    draw = ImageDraw.Draw(layer)
    box = draw.multiline_textbbox((0, 0), text, font=font, spacing=spacing, stroke_width=stroke, align=h)
    tw, th = box[2] - box[0], box[3] - box[1]
    margin = round(0.04 * min(width, height))
    x = {"left": margin, "center": (width - tw) / 2, "right": width - margin - tw}[h] - box[0]
    y = {"top": margin, "middle": (height - th) / 2, "bottom": height - margin - th}[v] - box[1]

    if ov.get("background"):
        pad = round(size * 0.3)
        draw.rounded_rectangle(
            (x + box[0] - pad, y + box[1] - pad, x + box[2] + pad, y + box[3] + pad),
            radius=pad, fill=(0, 0, 0, 140),
        )
    draw.multiline_text((x, y), text, font=font, fill=fill, spacing=spacing, align=h,
                        stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
    return layer


class VideoService:
    def _resolve_media_path(self, filename: str, subfolder: str, type_: str) -> Path:
        """Resolves a ComfyUI-style {filename, subfolder, type} reference to an
        absolute path, guarding against path traversal outside the matching
        input/output/temp directory."""
        import folder_paths  # type: ignore

        base_dir = folder_paths.get_directory_by_type(type_)
        if not base_dir:
            raise ValueError(f"Invalid type: {type_}")
        base = Path(base_dir).resolve()
        target = (base / (subfolder or "") / filename).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            raise ValueError("Access denied: path outside allowed directory")
        if not target.is_file():
            raise FileNotFoundError(f"File not found: {filename}")
        return target

    def save_frame_to_output(self, image_base64: str, filename_prefix: str = "video/Frame") -> dict:
        """Saves a client-captured video frame (PNG data URL) into ComfyUI's own
        output folder — same auto-numbered pattern as Lab's index-image save
        (see LabPlanService.save_index_image_to_output)."""
        import folder_paths  # type: ignore

        b64 = image_base64
        if "," in b64 and b64.strip().lower().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        image_bytes = base64.b64decode(b64)

        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, output_dir)
        save_name = f"{filename}_{counter:05}_.png"
        save_path = Path(full_output_folder) / save_name
        save_path.write_bytes(image_bytes)
        return {"filename": save_name, "subfolder": subfolder}

    def probe_video(self, filename: str, subfolder: str, type_: str) -> dict:
        """Reads duration/dimensions/fps/audio presence via PyAV only (no ffmpeg
        subprocess) — used by the Video Edit tab right after a clip is added, so
        the timeline UI can show its length and the export-time resolution-match
        check has real numbers to compare against."""
        import av  # type: ignore

        src_path = self._resolve_media_path(filename, subfolder, type_)
        container = av.open(str(src_path))
        try:
            stream = container.streams.video[0]
            fps = float(stream.average_rate) if stream.average_rate else 0.0
            if stream.duration is not None and stream.time_base is not None:
                duration = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                duration = float(container.duration) / 1_000_000
            else:
                duration = 0.0
            width = stream.codec_context.width
            height = stream.codec_context.height
            has_audio = len(container.streams.audio) > 0
        finally:
            container.close()

        return {
            "duration": duration,
            "width": width,
            "height": height,
            "fps": fps,
            "has_audio": has_audio,
        }

    def convert_to_gif(
        self,
        filename: str,
        subfolder: str,
        type_: str,
        start_time: float = 0.0,
        end_time=None,
        fps: float = 10.0,
        max_width=None,
        filename_prefix: str = "video/GIF",
    ) -> dict:
        """Decodes the given video (PyAV), samples it down to `fps`, optionally
        downscales to `max_width`, and encodes the result as an animated GIF
        (Pillow) into ComfyUI's own output folder."""
        import av  # type: ignore
        import folder_paths  # type: ignore

        if _RESAMPLE is None:
            raise RuntimeError("Pillow is not available")

        src_path = self._resolve_media_path(filename, subfolder, type_)
        fps = max(0.1, float(fps))

        container = av.open(str(src_path))
        try:
            stream = container.streams.video[0]
            source_fps = float(stream.average_rate) if stream.average_rate else 24.0
            step = max(1, round(source_fps / fps))

            pil_frames = []
            idx = 0
            for frame in container.decode(stream):
                t = float(frame.pts * stream.time_base) if frame.pts is not None else None
                if t is not None:
                    if t < start_time:
                        idx += 1
                        continue
                    if end_time is not None and t > end_time:
                        break
                if idx % step == 0:
                    im = frame.to_image()
                    if max_width and im.width > max_width:
                        ratio = max_width / im.width
                        im = im.resize((max_width, max(1, round(im.height * ratio))), _RESAMPLE)
                    pil_frames.append(im.convert("RGB"))
                idx += 1
        finally:
            container.close()

        if not pil_frames:
            raise ValueError("No frames found in the specified range")

        output_dir = folder_paths.get_output_directory()
        full_output_folder, out_filename, counter, out_subfolder, _ = folder_paths.get_save_image_path(filename_prefix, output_dir)
        save_name = f"{out_filename}_{counter:05}_.gif"
        save_path = Path(full_output_folder) / save_name

        duration_ms = max(20, round(1000 / fps))
        pil_frames[0].save(
            save_path,
            format="GIF",
            save_all=True,
            append_images=pil_frames[1:],
            duration=duration_ms,
            loop=0,
            optimize=True,
        )
        return {"filename": save_name, "subfolder": out_subfolder, "frame_count": len(pil_frames)}

    def overlay_text_on_video(
        self,
        filename: str,
        subfolder: str,
        type_: str,
        overlays: list,
        filename_prefix: str = "video/wfm_edit",
        delete_source: bool = False,
    ) -> dict:
        """Burns timed text overlays into a video (Video Edit tab, Phase 3).

        ComfyUI core has no time-ranged video text node (core TextOverlay draws
        on every frame of an IMAGE batch, top/bottom only), and routing the
        whole timeline through IMAGE tensors would hold every decoded frame in
        memory at once — so this streams instead: decode one frame, composite
        any overlay whose [start, end) covers it, encode, repeat. Audio packets
        are remuxed untouched (no audio re-encode), so the soundtrack built by
        the export graph (original audio / BGM) survives this pass as-is.

        overlays: [{text, start, end, font_size (% of frame height), color,
        anchor ("<top|middle|bottom>-<left|center|right>"), outline, background}]
        with start/end in seconds from the start of the video.
        """
        import av  # type: ignore
        import folder_paths  # type: ignore

        src_path = self._resolve_media_path(filename, subfolder, type_)
        items = []
        for ov in overlays or []:
            try:
                start = max(0.0, float(ov.get("start") or 0.0))
                end = float(ov.get("end") or 0.0)
            except (TypeError, ValueError):
                continue
            if end > start and str(ov.get("text") or "").strip():
                items.append((start, end, ov))
        if not items:
            raise ValueError("No valid text overlays")

        output_dir = folder_paths.get_output_directory()
        full_output_folder, out_filename, counter, out_subfolder, _ = folder_paths.get_save_image_path(filename_prefix, output_dir)
        save_name = f"{out_filename}_{counter:05}_.mp4"
        save_path = Path(full_output_folder) / save_name

        in_c = av.open(str(src_path))
        out_c = None
        try:
            in_v = in_c.streams.video[0]
            in_a = in_c.streams.audio[0] if in_c.streams.audio else None
            width, height = in_v.codec_context.width, in_v.codec_context.height
            rate = in_v.average_rate or in_v.guessed_rate or 24

            layers = [(s, e, _render_text_layer(width, height, ov)) for s, e, ov in items]

            out_c = av.open(str(save_path), mode="w")
            out_v = out_c.add_stream("libx264", rate=rate)
            out_v.width = width
            out_v.height = height
            out_v.pix_fmt = "yuv420p"
            out_v.options = {"crf": "18", "preset": "medium"}
            out_a = out_c.add_stream_from_template(in_a) if in_a is not None else None

            streams = [in_v] + ([in_a] if in_a is not None else [])
            first_pts = None
            index = 0
            for packet in in_c.demux(*streams):
                if packet.stream.type == "audio":
                    if packet.dts is None:
                        continue
                    packet.stream = out_a
                    out_c.mux(packet)
                    continue
                for frame in packet.decode():
                    if frame.pts is not None and first_pts is None:
                        first_pts = frame.pts
                    t = float((frame.pts - first_pts) * in_v.time_base) if frame.pts is not None else index / float(rate)
                    active = [layer for s, e, layer in layers if s <= t < e]
                    if active:
                        img = frame.to_image().convert("RGBA")
                        for layer in active:
                            img.alpha_composite(layer)
                        out_frame = av.VideoFrame.from_image(img.convert("RGB"))
                    else:
                        out_frame = frame
                    out_frame.pts = index
                    out_frame.time_base = out_v.codec_context.time_base
                    index += 1
                    for out_packet in out_v.encode(out_frame):
                        out_c.mux(out_packet)
            for out_packet in out_v.encode(None):
                out_c.mux(out_packet)
        except BaseException:
            if out_c is not None:
                out_c.close()
                out_c = None
            save_path.unlink(missing_ok=True)
            raise
        finally:
            if out_c is not None:
                out_c.close()
            in_c.close()

        # The export graph's intermediate file is only deleted when the caller
        # explicitly asks and it's one of this tab's own "_pre" intermediates in
        # output — never an arbitrary user file.
        if delete_source and type_ == "output" and Path(filename).name.startswith("wfm_edit_pre"):
            try:
                src_path.unlink()
            except OSError as e:
                logger.warning("Could not delete intermediate %s: %s", src_path, e)

        return {"filename": save_name, "subfolder": out_subfolder, "frame_count": index}
