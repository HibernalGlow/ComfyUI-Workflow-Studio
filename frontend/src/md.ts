/**
 * material-web element wrappers for React.
 *
 * @material/web ships Lit custom elements. Rendering them as raw JSX tags makes
 * property-vs-attribute coercion and custom-event wiring implicit, so each
 * element the app uses goes through @lit/react's createComponent instead:
 * properties are set as properties, and every event name is declared once here
 * and surfaces as a typed `on*` prop.
 *
 * Event names were verified against the library's own typings rather than
 * assumed from MDC v3:
 *   md-dialog  -> open, opened, close, closed, cancel
 *   md-menu    -> opening, opened, closing, closed
 *   select / text-field / slider / tabs / switch / checkbox / radio / chip
 *              -> change, input   (chips also: remove)
 */

import * as React from "react";
import { createComponent } from "@lit/react";
import type { ReactWebComponent } from "@lit/react";

// --- side-effect registrations ---------------------------------------------
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
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/textfield/filled-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/filled-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/switch/switch.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/radio/radio.js";
import "@material/web/chips/assist-chip.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/chips/input-chip.js";
import "@material/web/chips/suggestion-chip.js";
import "@material/web/chips/chip-set.js";
import "@material/web/dialog/dialog.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/divider/divider.js";
import "@material/web/icon/icon.js";
import "@material/web/labs/card/filled-card.js";
import "@material/web/labs/card/outlined-card.js";
import "@material/web/labs/card/elevated-card.js";
import "@material/web/labs/item/item.js";

import type { MdFilledButton as FilledButtonEl } from "@material/web/button/filled-button.js";
import type { MdFilledTonalButton as FilledTonalButtonEl } from "@material/web/button/filled-tonal-button.js";
import type { MdOutlinedButton as OutlinedButtonEl } from "@material/web/button/outlined-button.js";
import type { MdTextButton as TextButtonEl } from "@material/web/button/text-button.js";
import type { MdElevatedButton as ElevatedButtonEl } from "@material/web/button/elevated-button.js";
import type { MdIconButton as IconButtonEl } from "@material/web/iconbutton/icon-button.js";
import type { MdFilledIconButton as FilledIconButtonEl } from "@material/web/iconbutton/filled-icon-button.js";
import type { MdOutlinedIconButton as OutlinedIconButtonEl } from "@material/web/iconbutton/outlined-icon-button.js";
import type { MdFab as FabEl } from "@material/web/fab/fab.js";
import type { MdOutlinedTextField as OutlinedTextFieldEl } from "@material/web/textfield/outlined-text-field.js";
import type { MdFilledTextField as FilledTextFieldEl } from "@material/web/textfield/filled-text-field.js";
import type { MdOutlinedSelect as OutlinedSelectEl } from "@material/web/select/outlined-select.js";
import type { MdFilledSelect as FilledSelectEl } from "@material/web/select/filled-select.js";
import type { MdSelectOption as SelectOptionEl } from "@material/web/select/select-option.js";
import type { MdSlider as SliderEl } from "@material/web/slider/slider.js";
import type { MdSwitch as SwitchEl } from "@material/web/switch/switch.js";
import type { MdCheckbox as CheckboxEl } from "@material/web/checkbox/checkbox.js";
import type { MdRadio as RadioEl } from "@material/web/radio/radio.js";
import type { MdAssistChip as AssistChipEl } from "@material/web/chips/assist-chip.js";
import type { MdFilterChip as FilterChipEl } from "@material/web/chips/filter-chip.js";
import type { MdInputChip as InputChipEl } from "@material/web/chips/input-chip.js";
import type { MdChipSet as ChipSetEl } from "@material/web/chips/chip-set.js";
import type { MdDialog as DialogEl } from "@material/web/dialog/dialog.js";
import type { MdMenu as MenuEl } from "@material/web/menu/menu.js";
import type { MdMenuItem as MenuItemEl } from "@material/web/menu/menu-item.js";
import type { MdList as ListEl } from "@material/web/list/list.js";
import type { MdListItem as ListItemEl } from "@material/web/list/list-item.js";
import type { MdTabs as TabsEl } from "@material/web/tabs/tabs.js";
import type { MdPrimaryTab as PrimaryTabEl } from "@material/web/tabs/primary-tab.js";
import type { MdLinearProgress as LinearProgressEl } from "@material/web/progress/linear-progress.js";
import type { MdCircularProgress as CircularProgressEl } from "@material/web/progress/circular-progress.js";
import type { MdDivider as DividerEl } from "@material/web/divider/divider.js";
import type { MdIcon as IconEl } from "@material/web/icon/icon.js";
import type { MdFilledCard as FilledCardEl } from "@material/web/labs/card/filled-card.js";
import type { MdOutlinedCard as OutlinedCardEl } from "@material/web/labs/card/outlined-card.js";
import type { MdElevatedCard as ElevatedCardEl } from "@material/web/labs/card/elevated-card.js";
import type { MdItem as ItemEl } from "@material/web/labs/item/item.js";

type EventMap = Record<string, string>;

/**
 * "This element dispatches no custom events."
 *
 * Must have an empty key set: `NoEvents` would make `keyof E`
 * equal `string`, which deletes every standard React prop from the wrapper
 * (children, className, …) and replaces them with `(e: never) => void`.
 */
type NoEvents = Record<never, never>;

/**
 * Build a React component for an already-registered `md-*` element.
 * Throws at module-eval time (i.e. during development, loudly) rather than
 * rendering a silently-inert custom element when an import is missing.
 */
function define<E extends HTMLElement, EV extends EventMap>(
    tagName: string,
    events?: EV,
): ReactWebComponent<E, EV> {
    const elementClass = customElements.get(tagName);
    if (!elementClass) {
        throw new Error(
            `<${tagName}> is not registered — add "@material/web/..." to the imports in frontend/src/md.ts`,
        );
    }
    return createComponent<E, EV>({
        react: React,
        tagName,
        elementClass: elementClass as unknown as new () => E,
        events: events ?? ({} as EV),
    });
}

const FORM = { onChange: "change", onInput: "input" } as const;

// --- buttons ---------------------------------------------------------------
export const MdFilledButton = define<FilledButtonEl, NoEvents>("md-filled-button");
export const MdFilledTonalButton = define<FilledTonalButtonEl, NoEvents>("md-filled-tonal-button");
export const MdOutlinedButton = define<OutlinedButtonEl, NoEvents>("md-outlined-button");
export const MdTextButton = define<TextButtonEl, NoEvents>("md-text-button");
export const MdElevatedButton = define<ElevatedButtonEl, NoEvents>("md-elevated-button");
export const MdIconButton = define<IconButtonEl, NoEvents>("md-icon-button");
export const MdFilledIconButton = define<FilledIconButtonEl, NoEvents>("md-filled-icon-button");
export const MdOutlinedIconButton = define<OutlinedIconButtonEl, NoEvents>("md-outlined-icon-button");
export const MdFab = define<FabEl, NoEvents>("md-fab");

// --- inputs ----------------------------------------------------------------
export const MdOutlinedTextField = define<OutlinedTextFieldEl, typeof FORM>("md-outlined-text-field", FORM);
export const MdFilledTextField = define<FilledTextFieldEl, typeof FORM>("md-filled-text-field", FORM);
export const MdOutlinedSelect = define<OutlinedSelectEl, typeof FORM>("md-outlined-select", FORM);
export const MdFilledSelect = define<FilledSelectEl, typeof FORM>("md-filled-select", FORM);
export const MdSelectOption = define<SelectOptionEl, NoEvents>("md-select-option");
export const MdSlider = define<SliderEl, typeof FORM>("md-slider", FORM);
export const MdSwitch = define<SwitchEl, typeof FORM>("md-switch", FORM);
export const MdCheckbox = define<CheckboxEl, typeof FORM>("md-checkbox", FORM);
export const MdRadio = define<RadioEl, typeof FORM>("md-radio", FORM);

// --- chips -----------------------------------------------------------------
export const MdAssistChip = define<AssistChipEl, typeof FORM>("md-assist-chip", FORM);
export const MdFilterChip = define<FilterChipEl, typeof FORM & { onRemove: "remove" }>("md-filter-chip", {
    ...FORM,
    onRemove: "remove",
});
export const MdInputChip = define<InputChipEl, typeof FORM & { onRemove: "remove" }>("md-input-chip", {
    ...FORM,
    onRemove: "remove",
});
export const MdChipSet = define<ChipSetEl, NoEvents>("md-chip-set");

// --- overlays + surfaces ---------------------------------------------------
export const MdDialog = define<DialogEl, {
    onOpen: "open";
    onOpened: "opened";
    onClose: "close";
    onClosed: "closed";
    onCancel: "cancel";
}>("md-dialog", {
    onOpen: "open",
    onOpened: "opened",
    onClose: "close",
    onClosed: "closed",
    onCancel: "cancel",
});
export const MdMenu = define<MenuEl, {
    onOpening: "opening";
    onOpened: "opened";
    onClosing: "closing";
    onClosed: "closed";
}>("md-menu", {
    onOpening: "opening",
    onOpened: "opened",
    onClosing: "closing",
    onClosed: "closed",
});
export const MdMenuItem = define<MenuItemEl, NoEvents>("md-menu-item");
export const MdList = define<ListEl, NoEvents>("md-list");
export const MdListItem = define<ListItemEl, NoEvents>("md-list-item");
export const MdTabs = define<TabsEl, typeof FORM>("md-tabs", FORM);
export const MdPrimaryTab = define<PrimaryTabEl, NoEvents>("md-primary-tab");
export const MdLinearProgress = define<LinearProgressEl, NoEvents>("md-linear-progress");
export const MdCircularProgress = define<CircularProgressEl, NoEvents>("md-circular-progress");
export const MdDivider = define<DividerEl, NoEvents>("md-divider");
export const MdIcon = define<IconEl, NoEvents>("md-icon");
export const MdFilledCard = define<FilledCardEl, NoEvents>("md-filled-card");
export const MdOutlinedCard = define<OutlinedCardEl, NoEvents>("md-outlined-card");
export const MdElevatedCard = define<ElevatedCardEl, NoEvents>("md-elevated-card");
export const MdItem = define<ItemEl, NoEvents>("md-item");
