/**
 * M3 Snackbar.
 *
 * @material/web 2.5.0 ships no snackbar (its labs cover badge, card, item,
 * navigation bar/drawer/tab and segmented button only), so the one
 * transient-feedback surface the app needs is implemented here against the M3
 * spec: inverse-surface colours, elevation 3, the 4/5/6/10 s duration scale,
 * and a single visible message at a time.
 */

import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { MdTextButton } from "./md.js";

const DURATION = { short: 4000, medium: 5000, long: 6000, extraLong: 10000 } as const;

export interface SnackbarOptions {
    label: string;
    actionLabel?: string | null;
    onAction?: (() => void) | null;
    duration?: keyof typeof DURATION | number;
    tone?: "neutral" | "error";
}

interface SnackbarEntry {
    id: number;
    label: string;
    actionLabel: string | null;
    onAction: (() => void) | null;
    tone: "neutral" | "error";
}

interface SnackbarApi {
    show: (options: SnackbarOptions | string) => { dismiss: () => void };
    dismiss: () => void;
}

const NOOP: SnackbarApi = { show: () => ({ dismiss: () => {} }), dismiss: () => {} };
const SnackbarContext = createContext<SnackbarApi>(NOOP);

export function useSnackbar(): SnackbarApi {
    return useContext(SnackbarContext);
}

export function SnackbarProvider({ children }: { children: ReactNode }): ReactNode {
    const [current, setCurrent] = useState<SnackbarEntry | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seq = useRef(0);

    const dismiss = useCallback((): void => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        setCurrent(null);
    }, []);

    const show = useCallback(
        (options: SnackbarOptions | string): { dismiss: () => void } => {
            const o: SnackbarOptions = typeof options === "string" ? { label: options } : options;
            if (!o.label) return { dismiss };
            const ms =
                typeof o.duration === "number"
                    ? o.duration
                    : DURATION[o.duration ?? "medium"] ?? DURATION.medium;
            seq.current += 1;
            setCurrent({
                id: seq.current,
                label: o.label,
                actionLabel: o.actionLabel ?? null,
                onAction: o.onAction ?? null,
                tone: o.tone ?? "neutral",
            });
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCurrent(null), ms);
            return { dismiss };
        },
        [dismiss],
    );

    const value = useMemo<SnackbarApi>(() => ({ show, dismiss }), [show, dismiss]);

    return (
        <SnackbarContext.Provider value={value}>
            {children}
            <div
                className="nu-snackbar-host"
                aria-live={current?.tone === "error" ? "assertive" : "polite"}
            >
                {current ? (
                    <div
                        className="nu-snackbar"
                        role={current.tone === "error" ? "alert" : "status"}
                        key={current.id}
                    >
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
