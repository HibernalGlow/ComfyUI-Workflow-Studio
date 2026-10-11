"""Regenerate README.index.md / DEVLOG.index.md from README.md / DEVLOG.md.

README.md and DEVLOG.md are excluded from graphify's semantic extraction
(.graphifyignore) and these condensed index files are extracted instead. DEVLOG.md
is excluded because it is too large for reliable local-Ollama extraction: big chunks
make the model summarize in prose instead of emitting JSON, and time out on slower
models/hardware. README.md is excluded so the graph gets the fork's intro block plus
one stable entry per section rather than the markup-heavy homepage. Run this whenever
README.md or DEVLOG.md changes, then `graphify --update` to refresh the graph.

Usage:
    python tools/generate_doc_index.py [readme|devlog|all]
    (defaults to "all")
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def generate_readme_index() -> Path:
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    intro = text.split("\n## ", 1)[0].strip()
    headings = [h.strip() for h in re.findall(r"^## (.+)$", text, re.M)]

    out = [
        "# README Index — ComfyUI-Workflow-Studio (fork)",
        "",
        "Condensed index of README.md: the fork's intro summary verbatim, then one "
        "line per section (the full prose, tables, code blocks and SVG embeds live in "
        "the excluded README.md). Exists so graphify can extract this without feeding "
        "the homepage markup to the local Ollama model. Regenerate with "
        "`python tools/generate_doc_index.py readme` whenever README.md changes.",
        "",
        intro,
        "",
        "## Sections",
        "",
        *[f"- {h}" for h in headings],
        "",
    ]

    content = "\n".join(out)
    out_path = ROOT / "README.index.md"
    out_path.write_text(content, encoding="utf-8")
    return out_path


def generate_devlog_index() -> Path:
    text = (ROOT / "DEVLOG.md").read_text(encoding="utf-8")

    entries = re.split(r"^## ", text, flags=re.M)[1:]
    lines: list[str] = []
    for entry in entries:
        parts = entry.split("\n", 1)
        version_line = parts[0].strip()
        rest = parts[1] if len(parts) > 1 else ""
        m = re.search(r"^### (.+)$", rest, re.M)
        subtitle = m.group(1).strip() if m else ""
        lines.append(
            f"- **{version_line}** — {subtitle}" if subtitle else f"- **{version_line}**"
        )

    out = [
        "# DEVLOG Index — ComfyUI-Workflow-Studio",
        "",
        "Condensed version-by-version index of DEVLOG.md (each line: version + "
        'one-line summary of what changed and why). Full rationale, code details, '
        'and "How to apply" lessons live in the excluded DEVLOG.md itself; this '
        "index exists so graphify can extract a queryable semantic node per release "
        "without feeding the full log to the local Ollama model. Regenerate with "
        "`python tools/generate_doc_index.py devlog` whenever DEVLOG.md changes.",
        "",
        *lines,
        "",
    ]

    content = "\n".join(out)
    out_path = ROOT / "DEVLOG.index.md"
    out_path.write_text(content, encoding="utf-8")
    return out_path


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    written: list[Path] = []
    if target in ("readme", "all"):
        written.append(generate_readme_index())
    if target in ("devlog", "all"):
        written.append(generate_devlog_index())
    if not written:
        print(f"unknown target {target!r}; use readme|devlog|all", file=sys.stderr)
        raise SystemExit(2)
    for p in written:
        print(f"wrote {p.relative_to(ROOT)} ({p.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
