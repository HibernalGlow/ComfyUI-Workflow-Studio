import type { ReactElement, ReactNode } from "react";
import { MdIcon } from "./md.js";

/**
 * The composed empty state: a tone-shaped bloom, an icon, a title and one line
 * of orientation. A blank box is the screen most likely to be seen on a fresh
 * install, so it gets the same shape language as the rest of the surface.
 */
export function EmptyState({
    icon,
    title,
    hint,
    children,
}: {
    icon: string;
    title: string;
    hint?: string;
    children?: ReactNode;
}): ReactElement {
    return (
        <div className="nu-empty">
            <span className="nu-empty__art" aria-hidden="true">
                <span className="nu-empty__bloom" />
                <MdIcon>{icon}</MdIcon>
            </span>
            <p className="nu-empty__title">{title}</p>
            {hint ? <p className="nu-empty__hint">{hint}</p> : null}
            {children}
        </div>
    );
}
