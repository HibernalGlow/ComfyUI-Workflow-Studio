/**
 * store.js — the new UI's subscription store (no third-party state library).
 *
 * Frozen shape (FREEZE-NEWUI.md):
 *   createStore(initial) -> { getState, setState(patch), subscribe(fn), select(selector, fn) }
 *
 * Contract
 *  - `setState(patch)` merges shallowly, notifies subscribers with `(state, patch)`
 *    and returns the new state — the previous state object is never mutated.
 *  - Calling `setState` *during* a notification is safe: the extra patch is queued
 *    and delivered as one more round once the current round ends, so listener
 *    calls never nest — no re-entrancy explosion.
 *  - A listener that throws is logged; it cannot stop the others, and `subscribe`
 *    may be called from inside a listener.
 *  - `select(selector, fn)` calls `fn(selected, previous)` only when the selected
 *    slice changes (Object.is), never at subscribe time — read `getState()` first.
 */

export function createStore(initial = {}) {
    let state = { ...initial };
    const listeners = new Set();
    let notifying = false;
    let queued = null;

    function notify(patch) {
        // Snapshot: a listener may subscribe/unsubscribe while it runs.
        for (const listener of Array.from(listeners)) {
            try {
                listener(state, patch);
            } catch (err) {
                console.error("[newui] store listener threw", err);
            }
        }
    }

    function flush(patch) {
        notifying = true;
        try {
            let current = patch;
            while (current) {
                notify(current);
                current = queued;
                queued = null;
            }
        } finally { notifying = false; }
    }

    const store = {
        getState() {
            return state;
        },
        setState(patch) {
            if (!patch || typeof patch !== "object") return state;
            state = { ...state, ...patch };
            if (notifying) queued = queued ? { ...queued, ...patch } : patch;
            else flush(patch);
            return state;
        },
        subscribe(listener) {
            if (typeof listener !== "function") return () => {};
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        select(selector, listener) {
            if (typeof selector !== "function" || typeof listener !== "function") return () => {};
            let previous = selector(state);
            return store.subscribe(() => {
                const selected = selector(state);
                if (Object.is(selected, previous)) return;
                const last = previous;
                previous = selected;
                listener(selected, last);
            });
        },
    };
    return store;
}
