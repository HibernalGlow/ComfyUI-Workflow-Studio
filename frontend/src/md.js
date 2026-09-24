/**
 * material-web element wrappers for React.
 *
 * @material/web ships Lit custom elements. Rendering them as raw JSX tags makes
 * property-vs-attribute coercion and custom-event wiring implicit, so every
 * element used by the app goes through @lit/react's createComponent instead:
 * properties are set as properties and each event name is declared once, here.
 *
 * The event names below are the ones the library actually dispatches (verified
 * against node_modules/@material/web/<area>/internal/*.d.ts @fires blocks),
 * not the MDC v3 names:
 *   md-dialog  -> open, opened, close, closed, cancel
 *   md-menu    -> opening, opened, closing, closed
 *   md-select / -text-field / -slider / -tabs / -switch / -checkbox -> change, input
 *   md-chip    -> change, remove
 */

import * as React from "react";
import { createComponent } from "@lit/react";

// --- buttons ---------------------------------------------------------------
import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/button/elevated-button.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/iconbutton/filled-icon-button.js";
import "@material/web/iconbutton/filled-tonal-icon-button.js";
import "@material/web/iconbutton/outlined-icon-button.js";
import "@material/web/fab/fab.js";
import "@material/web/fab/branded-fab.js";

// --- inputs ----------------------------------------------------------------
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/textfield/filled-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/filled-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/switch/switch.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/radio/radio.js";

// --- chips -----------------------------------------------------------------
import "@material/web/chips/assist-chip.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/chips/input-chip.js";
import "@material/web/chips/suggestion-chip.js";
import "@material/web/chips/chip-set.js";

// --- surfaces + overlays ---------------------------------------------------
import "@material/web/dialog/dialog.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import "@material/web/menu/sub-menu.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/tabs/secondary-tab.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/divider/divider.js";
import "@material/web/icon/icon.js";
import "@material/web/ripple/ripple.js";
import "@material/web/focus/md-focus-ring.js";
import "@material/web/elevation/elevation.js";

// --- labs (cards, items, segmented buttons, badge) --------------------------
import "@material/web/labs/card/filled-card.js";
import "@material/web/labs/card/elevated-card.js";
import "@material/web/labs/card/outlined-card.js";
import "@material/web/labs/item/item.js";
import "@material/web/labs/badge/badge.js";
import "@material/web/labs/segmentedbutton/outlined-segmented-button.js";
import "@material/web/labs/segmentedbuttonset/outlined-segmented-button-set.js";

const cache = new Map();

function wrap(tagName, events = {}) {
    const elementClass = customElements.get(tagName);
    if (!elementClass) {
        throw new Error(
            `<${tagName}> was not registered — add its import to frontend/src/md.js`,
        );
    }
    return createComponent({ react: React, tagName, elementClass, events });
}

/** Lazily-created, cached wrapper for any registered `md-*` element. */
export function Md(tagName, events = {}) {
    const key = tagName + "|" + Object.keys(events).sort().join(",");
    if (!cache.has(key)) cache.set(key, wrap(tagName, events));
    return cache.get(key);
}

const FORM = { onChange: "change", onInput: "input" };

export const MdFilledButton = Md("md-filled-button");
export const MdFilledTonalButton = Md("md-filled-tonal-button");
export const MdOutlinedButton = Md("md-outlined-button");
export const MdTextButton = Md("md-text-button");
export const MdElevatedButton = Md("md-elevated-button");

export const MdIconButton = Md("md-icon-button");
export const MdFilledIconButton = Md("md-filled-icon-button");
export const MdFilledTonalIconButton = Md("md-filled-tonal-icon-button");
export const MdOutlinedIconButton = Md("md-outlined-icon-button");
export const MdFab = Md("md-fab");
export const MdBrandedFab = Md("md-branded-fab");

export const MdOutlinedTextField = Md("md-outlined-text-field", FORM);
export const MdFilledTextField = Md("md-filled-text-field", FORM);
export const MdOutlinedSelect = Md("md-outlined-select", FORM);
export const MdFilledSelect = Md("md-filled-select", FORM);
export const MdSelectOption = Md("md-select-option");
export const MdSlider = Md("md-slider", FORM);
export const MdSwitch = Md("md-switch", FORM);
export const MdCheckbox = Md("md-checkbox", FORM);
export const MdRadio = Md("md-radio", FORM);

export const MdAssistChip = Md("md-assist-chip", FORM);
export const MdFilterChip = Md("md-filter-chip", { ...FORM, onRemove: "remove" });
export const MdInputChip = Md("md-input-chip", { ...FORM, onRemove: "remove" });
export const MdSuggestionChip = Md("md-suggestion-chip", FORM);
export const MdChipSet = Md("md-chip-set");

export const MdDialog = Md("md-dialog", {
    onOpen: "open",
    onOpened: "opened",
    onClose: "close",
    onClosed: "closed",
    onCancel: "cancel",
});
export const MdMenu = Md("md-menu", {
    onOpening: "opening",
    onOpened: "opened",
    onClosing: "closing",
    onClosed: "closed",
});
export const MdMenuItem = Md("md-menu-item");
export const MdSubMenu = Md("md-sub-menu");

export const MdList = Md("md-list");
export const MdListItem = Md("md-list-item");
export const MdTabs = Md("md-tabs", FORM);
export const MdPrimaryTab = Md("md-primary-tab");
export const MdSecondaryTab = Md("md-secondary-tab");

export const MdLinearProgress = Md("md-linear-progress");
export const MdCircularProgress = Md("md-circular-progress");
export const MdDivider = Md("md-divider");
export const MdIcon = Md("md-icon");
export const MdRipple = Md("md-ripple");
export const MdFocusRing = Md("md-focus-ring");
export const MdElevation = Md("md-elevation");

export const MdFilledCard = Md("md-filled-card");
export const MdElevatedCard = Md("md-elevated-card");
export const MdOutlinedCard = Md("md-outlined-card");
export const MdItem = Md("md-item");
export const MdBadge = Md("md-badge");
export const MdSegmentedButton = Md("md-outlined-segmented-button", {
    onChange: "change",
    onInput: "input",
});
export const MdSegmentedButtonSet = Md("md-outlined-segmented-button-set");
