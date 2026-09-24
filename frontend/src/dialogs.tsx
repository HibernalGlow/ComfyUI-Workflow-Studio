/**
 * M3 confirm / prompt dialogs.
 *
 * These replace `window.confirm` and `window.prompt`, which block the main thread,
 * ignore the colour scheme and cannot be styled — exactly the kind of rough edge
 * this refactor exists to remove. `md-dialog` supplies the focus trap, scrim and Escape
 * handling, so none of that is reimplemented here.
 *
 * Verified against the compiled component (node_modules/@material/web/dialog/internal/dialog.js):
 * slots are `icon` / `headline` / `content` / `actions`; the buttons sit inside the
 * `actions` slot; and it closes imperatively via `close(returnValue)` — there is no
 * declarative `dialogAction` to lean on, so every action calls `close(value)` and the
 * promise resolves from the `close` event by reading `returnValue`.
 *
 * Focus restoration is *not* left to the component: this portal is torn down as soon as
 * the dialog settles, which removes the node before md-dialog can hand focus back, and
 * measured behaviour was Escape leaving focus on `<body>`. `mount()` remembers the opener.
 */

import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MdDialog, MdTextButton, MdFilledButton, MdIcon } from "./md.js";
import { tr } from "core";

type DialogElement = HTMLElement & {
    show: () => void;
    close: (returnValue?: string) => void;
    returnValue: string;
};

interface Base {
    title: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
}

type Ref = { current: DialogElement | null };

function mount<T>(render: (finish: (value: T) => void) => React.ReactElement): Promise<T> {
    return new Promise<T>((resolve) => {
        const host = document.createElement("div");
        host.className = "nu-dialog-portal";
        const returnTo = document.activeElement as HTMLElement | null;
        document.body.append(host);
        let root: Root | null = null;
        let closed = false;
        const settle = (value: T): void => {
            if (closed) return;
            closed = true;
            resolve(value);
            // Restore focus *after* the dialog is gone. While it is still open md-dialog
            // marks the rest of the page inert, and focusing an inert element fails
            // silently; doing it before teardown left focus on <body>. The node removal
            // happens in a microtask so a closing animation that never fires (reduced
            // motion, or a fast unmount) cannot leak the portal.
            queueMicrotask(() => {
                root?.unmount();
                host.remove();
                if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
            });
        };
        root = createRoot(host);
        root.render(render(settle));
    });
}

/**
 * Open the dialog once the element exists. The `data-shown` guard is required: React
 * StrictMode attaches refs twice in development and calling show() twice re-enters
 * the dialog's opening animation.
 */
function attachRef(ref: Ref, node: DialogElement | null): void {
    ref.current = node;
    if (node && !node.hasAttribute("data-shown")) {
        node.setAttribute("data-shown", "1");
        queueMicrotask(() => node.show());
    }
}

function buttons(
    ref: Ref,
    confirmLabel: string,
    cancelLabel: string,
    danger: boolean,
): React.ReactElement {
    return (
        <>
            <MdTextButton onClick={() => ref.current?.close("cancel")}>{cancelLabel}</MdTextButton>
            {danger ? (
                <MdFilledButton className="nu-btn--danger" onClick={() => ref.current?.close("confirm")}>
                    {confirmLabel}
                </MdFilledButton>
            ) : (
                <MdFilledButton onClick={() => ref.current?.close("confirm")}>{confirmLabel}</MdFilledButton>
            )}
        </>
    );
}

/** Resolve true on confirm; false on cancel, Escape or scrim click. */
export function confirmDialog({
    title,
    body,
    confirmLabel = tr("nu.action.confirm", "Confirm"),
    cancelLabel = tr("nu.action.cancel", "Cancel"),
    danger = false,
}: Base): Promise<boolean> {
    const ref: Ref = createRef();
    return mount<boolean>((finish) => (
        <MdDialog
            ref={(el) => attachRef(ref, el as DialogElement | null)}
            onClose={() => finish(ref.current?.returnValue === "confirm")}
            onCancel={(event) => {
                // Escape / backdrop: close it explicitly so returnValue is deterministic.
                event.preventDefault();
                ref.current?.close("cancel");
            }}
        >
            {danger ? (
                <MdIcon slot="icon" aria-hidden="true">
                    warning
                </MdIcon>
            ) : null}
            <div slot="headline">{title}</div>
            <div slot="content" className="nu-dialog__body">
                {body ?? ""}
            </div>
            <div slot="actions" className="nu-dialog__actions">
                {buttons(ref, confirmLabel, cancelLabel ?? tr("nu.action.cancel", "Cancel"), danger)}
            </div>
        </MdDialog>
    ));
}

/** Resolve the entered text on confirm, or null when cancelled. */
export function promptDialog({
    title,
    body,
    value = "",
    confirmLabel = tr("nu.action.save", "Save"),
    cancelLabel = tr("nu.action.cancel", "Cancel"),
}: Base & { value?: string }): Promise<string | null> {
    const ref: Ref = createRef();
    const draft = { current: value };
    return mount<string | null>((finish) => (
        <MdDialog
            ref={(el) => attachRef(ref, el as DialogElement | null)}
            onClose={() => finish(ref.current?.returnValue === "confirm" ? draft.current : null)}
            onCancel={(event) => {
                event.preventDefault();
                ref.current?.close("cancel");
            }}
        >
            <div slot="headline">{title}</div>
            <div slot="content" className="nu-dialog__body">
                {body ? <p className="nu-muted">{body}</p> : null}
                <input
                    className="nu-dialog__input"
                    defaultValue={value}
                    onInput={(e) => {
                        draft.current = (e.target as HTMLInputElement).value;
                    }}
                />
            </div>
            <div slot="actions" className="nu-dialog__actions">
                {buttons(ref, confirmLabel, cancelLabel, false)}
            </div>
        </MdDialog>
    ));
}
