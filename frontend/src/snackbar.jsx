/**
 * M3 Snackbar.
 *
 * @material/web 2.5.0 ships no snackbar component (its labs cover badge, card,
 * item, navigation bar/drawer/tab and segmented button only), so the one
 * transient-feedback surface the app needs is implemented here against the M3
 * spec: inverse-surface colours, elevation 3, a 4/5/6/10 s duration scale, and
 * one visible message at a time.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { MdTextButton } from "./md.js";

const DURATION = { short: 4000, medium: 5000, long: 6000, extraLong: 10000 };

const SnackbarContext = createContext({ show: () => {} });

export function useSnackbar() {
    return useContext(SnackbarContext);
}

export function SnackbarProvider({ children }) {
    const [current, setCurrent] = useState(null);
    const timer = useRef(null);
    const seq = useRef(0);

    const dismiss = useCallback(() => {
        clearTimeout(timer.current);
        timer.current = null;
        setCurrent(null);
    }, []);

    /**
     * @param {{label:string, actionLabel?:string, onAction?:()=>void,
     *          duration?:'short'|'medium'|'long'|'extraLong'|number,
     *          tone?:'neutral'|'error'}} options
     */
    const show = useCallback(
        (options) => {
            const {
                label,
                actionLabel = null,
                onAction = null,
                duration = "medium",
                tone = "neutral",
            } = typeof options === "string" ? { label: options } : options || {};
            if (!label) return { dismiss };
            const ms = typeof duration === "number" ? duration : DURATION[duration] ?? DURATION.medium;
            seq.current += 1;
            setCurrent({ id: seq.current, label, actionLabel, onAction, tone });
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCurrent(null), ms);
            return { dismiss };
        },
        [dismiss],
    );

    const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

    return (
        <SnackbarContext.Provider value={value}>
            {children}
            <div className="nu-snackbar-host" aria-live={current?.tone === "error" ? "assertive" : "polite"}>
                {current ? (
                    <div className="nu-snackbar" role={current.tone === "error" ? "alert" : "status"}>
                        <span className="nu-snackbar__label">{current.label}</span>
                        {current.actionLabel ? (
                            <MdTextButton
                                onClick={() => {
                                    current.onAction?.();
                                    dismiss();
                                }}
                            >
                                {current.actionLabel}
                            </MdTextButton>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </SnackbarContext.Provider>
    );
}
