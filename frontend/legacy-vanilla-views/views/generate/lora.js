/**
 * views/generate/lora.js — story-board LoRA panel (parity item 4) for the Generate view.
 *
 * Composes core/lora.js only:
 *   - `loadStoryContent(text, {filename, autoTurbo})`  -> matched LoRAs + the parsed positive prompt
 *   - `matchLoras(text, {autoTurbo})`                  -> match already-typed prompt text
 *   - `setLoraActive` / `setLoraWeight` / `removeLora` -> the chip mutations (pure, in-place)
 * The state object (`matchedLoras`) belongs to the caller (`createLoraPanel` keeps it, the Generate
 * view reads it through `getLoras()` so the pipeline receives the same array).
 *
 * The old UI's category colours are deliberately not reproduced: colour literals are forbidden in
 * newui, so the category is rendered as text and left to the stylesheet.
 */

import { lora, t } from "../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createCheckbox } from "../../components/Checkbox.js";
import { createIconButton } from "../../components/IconButton.js";
import { createSwitch } from "../../components/Switch.js";
import { createTextField } from "../../components/TextField.js";

function tr(key, fallback) {
    const value = t(key);
    return value !== undefined && value !== null && value !== key ? String(value) : fallback;
}

/**
 * @param {{onUsePrompt?:(text:string)=>void, onMessage?:(label:string)=>void}} [options]
 * @returns {{root:HTMLElement, getLoras():Array, setLoras(list:Array):void,
 *            isAutoInject():boolean, dispose():void}}
 */
export function createLoraPanel({ onUsePrompt = null, onMessage = null } = {}) {
    const state = lora.createStoryLoraState();
    const root = document.createElement("div");
    root.className = "nu-generate-lora";

    /* ---------------------------------------------------------------- source */
    const source = document.createElement("div");
    source.className = "nu-stack";

    const story = createTextField({
        label: tr("storyText", "Story text"),
        multiline: true,
        rows: 5,
        placeholder: tr("storyPlaceholder", "Paste an LN*.txt story or a prompt, then match LoRAs"),
    });

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.hidden = true;
    fileInput.accept = ".txt,text/plain";
    fileInput.addEventListener("change", async () => {
        const file = (fileInput.files || [])[0];
        fileInput.value = "";
        if (!file) return;
        story.setValue(await file.text());
        state.currentFile = file.name;
        fileLabel.textContent = file.name;
    });

    const fileLabel = document.createElement("span");
    fileLabel.className = "nu-muted";
    fileLabel.textContent = tr("noStoryFile", "no file loaded");

    const sourceActions = document.createElement("div");
    sourceActions.className = "nu-row";
    sourceActions.append(
        createButton({
            label: tr("loadStoryFile", "Load .txt"),
            variant: "outlined",
            onClick: () => fileInput.click(),
        }),
        createButton({ label: tr("matchLoras", "Match LoRAs"), variant: "tonal", onClick: () => runMatch() }),
        fileLabel
    );
    source.append(story.root, sourceActions);

    /* -------------------------------------------------------------- results */
    const promptOut = document.createElement("pre");
    promptOut.className = "nu-generate-lora__prompt";
    promptOut.setAttribute("aria-live", "polite");

    const chipList = document.createElement("div");
    chipList.className = "nu-generate-lora__list";

    const usePrompt = createButton({
        label: tr("useAsPrompt", "Use as positive prompt"),
        variant: "text",
        onClick: () => onUsePrompt?.(lora.toPositivePrompt(state.parsedPrompt, story.getValue())),
    });

    root.append(source, promptOut, chipList, usePrompt, fileInput);

    /* ------------------------------------------------------------- painting */
    function paintChips() {
        chipList.replaceChildren();
        if (state.matchedLoras.length === 0) {
            const empty = document.createElement("p");
            empty.className = "nu-empty";
            empty.textContent = tr("noLorasMatched", "No LoRA matched yet.");
            chipList.append(empty);
            return;
        }

        state.matchedLoras.forEach((entry, index) => {
            const card = document.createElement("div");
            card.className = "nu-generate-lora__item";

            const head = document.createElement("div");
            head.className = "nu-row";
            head.append(
                createCheckbox({
                    label: "",
                    checked: entry.active !== false,
                    onChange: (event) => {
                        lora.setLoraActive(state.matchedLoras, index, event.target.checked);
                    },
                }).root,
                text(entry.name || entry.path || "", "nu-generate-lora__name"),
                text(String(entry.category || "lora"), "nu-badge nu-generate-lora__category"),
                entry.trigger ? text(`[${entry.trigger}]`, "nu-muted nu-generate-lora__trigger") : document.createTextNode(""),
                createIconButton({
                    icon: "x",
                    ariaLabel: tr("remove", "Remove"),
                    variant: "standard",
                    onClick: () => {
                        lora.removeLora(state.matchedLoras, index);
                        paintChips();
                    },
                })
            );

            const weights = document.createElement("div");
            weights.className = "nu-row nu-generate-lora__weights";
            for (const field of ["model_weight", "clip_weight"]) {
                const handle = createTextField({
                    label: field === "model_weight" ? "M" : "C",
                    type: "number",
                    step: "0.05",
                    min: "-5",
                    max: "5",
                    value: entry[field] === undefined || entry[field] === null ? "" : String(entry[field]),
                    onChange: (event) => lora.setLoraWeight(state.matchedLoras, index, field, event.target.value),
                });
                weights.append(handle.root);
            }

            card.append(head, weights);
            chipList.append(card);
        });
    }

    function text(value, className) {
        const node = document.createElement("span");
        node.className = className;
        node.textContent = value;
        return node;
    }

    function applyMatch(result) {
        state.matchedLoras = result.matchedLoras || [];
        if (result.parsedPrompt !== undefined) state.parsedPrompt = result.parsedPrompt;
        story.setSupportingText?.(null);
        const prompt = lora.toPositivePrompt(state.parsedPrompt, story.getValue());
        promptOut.textContent = prompt;
        usePrompt.disabled = !prompt;
        paintChips();
        onUsePrompt?.(prompt);
    }

    async function runMatch() {
        const content = story.getValue();
        if (!content.trim()) {
            state.matchedLoras = [];
            state.parsedPrompt = null;
            paintChips();
            return;
        }
        try {
            if (state.currentFile) {
                applyMatch(await lora.loadStoryContent(content, {
                    filename: state.currentFile,
                    autoTurbo: state.autoTurbo,
                }));
            } else {
                applyMatch(await lora.matchLoras(content, { autoTurbo: state.autoTurbo }));
            }
        } catch (err) {
            onMessage?.(`${tr("matchFailed", "LoRA match failed")}: ${err?.message || err}`);
        }
    }

    /* ------------------------------------------------------------ auto-turbo */
    const turbo = createSwitch({
        label: tr("autoTurbo", "Auto Turbo"),
        checked: state.autoTurbo,
        onChange: (event) => {
            state.autoTurbo = event.target.checked;
            if (story.getValue().trim()) runMatch();
        },
    });

    // The auto-inject toggle lives in the Generate view (its own state); this panel only
    // contributes the switch that decides whether the server prepends Turbo.
    const turboRow = document.createElement("div");
    turboRow.className = "nu-row";
    turboRow.append(turbo.root);
    source.append(turboRow);

    paintChips();

    return {
        root,
        getLoras: () => state.matchedLoras,
        setLoras(list) {
            state.matchedLoras = Array.isArray(list) ? list : [];
            state.parsedPrompt = null;
            paintChips();
        },
        isAutoInject: () => true,
        dispose() {
            story.root.remove?.();
        },
    };
}
