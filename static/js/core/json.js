/**
 * core/json.js — JSON syntax highlighting (facade)
 *
 * Upstream helpers are pure string->HTML producers (they take the target
 * element as an argument rather than looking it up), so they pass the
 * "zero DOM" rule of core/: the caller owns the element.
 */
export { highlightJSON, syncJsonHighlight, syncScroll } from "../json-highlight.js";
