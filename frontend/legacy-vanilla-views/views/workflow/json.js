/**
 * views/workflow/json.js — raw-JSON panel with syntax highlighting and an editable textarea.
 *
 * The form and the JSON are two views of one object; this panel is the JSON side. It never parses
 * by itself: the caller owns the workflow, gets the parsed object through `onApply` and decides
 * whether to adopt it (the Workflow view re-analyses, the Generate view re-uses its loader).
 *
 * `highlightJSON` escapes `& < >` before wrapping tokens, so the `<pre>` gets server-supplied
 * workflow text safely; the textarea keeps the raw text, which is also what the user edits.
 */

import { highlightJSON, json, t } from "../../core/index.js";
import { createButton } from "../../components/Button.js";

function tr(key, fallback) {
    const value = t(key);
    return value !== undefined && value !== null && value !== key ? String(value) : fallback;
}

/**
 * @param {{value?:object, onApply?:(parsed:object)=>void, readOnly?:boolean}} [options]
 * @returns {{root:HTMLElement, setValue(workflow:object):void, getText():string}}
 */
export function createJsonPanel({ value = null, onApply = null, readOnly = false } = {}) {
    let current = value;

    const root = document.createElement("div");
    root.className = "nu-workflow-json";

    const frame = document.createElement("div");
    frame.className = "nu-workflow-json__frame";

    const highlight = document.createElement("pre");
    highlight.className = "nu-workflow-json__highlight";
    highlight.setAttribute("aria-hidden", "true");

    const editor = document.createElement("textarea");
    editor.className = "nu-workflow-json__editor";
    editor.spellcheck = false;
    editor.readOnly = readOnly;
    editor.setAttribute("aria-label", tr("rawJson", "Raw JSON"));
    editor.rows = 18;

    const status = document.createElement("p");
    status.className = "nu-muted nu-workflow-json__status";
    status.setAttribute("role", "status");

    function setText(text) {
        editor.value = text;
        highlight.innerHTML = highlightJSON(text) + "\n"; // highlightJSON escapes the payload
    }

    function sync() {
        json.syncScroll(editor, highlight);
    }

    function apply() {
        let parsed;
        try {
            parsed = JSON.parse(editor.value);
        } catch (err) {
            status.textContent = tr("invalidJson", "Invalid JSON") + `: ${err.message}`;
            status.classList.add("nu-error");
            return;
        }
        status.classList.remove("nu-error");
        status.textContent = tr("jsonApplied", "JSON applied.");
        current = parsed;
        highlight.innerHTML = highlightJSON(editor.value) + "\n";
        onApply?.(parsed);
    }

    editor.addEventListener("input", () => {
        highlight.innerHTML = highlightJSON(editor.value) + "\n";
    });
    editor.addEventListener("scroll", sync);

    frame.append(highlight, editor);

    const actions = document.createElement("div");
    actions.className = "nu-row";
    if (!readOnly) {
        actions.append(
            createButton({
                label: tr("apply", "Apply"),
                variant: "tonal",
                onClick: apply,
            }),
            createButton({
                label: tr("revert", "Revert"),
                variant: "text",
                onClick: () => {
                    setText(JSON.stringify(current || {}, null, 2));
                    status.textContent = "";
                    status.classList.remove("nu-error");
                },
            })
        );
    }
    actions.append(status);
    root.append(frame, actions);

    setText(JSON.stringify(current || {}, null, 2));

    return {
        root,
        setValue(workflow) {
            current = workflow;
            setText(JSON.stringify(workflow || {}, null, 2));
        },
        getText() {
            return editor.value;
        },
    };
}
