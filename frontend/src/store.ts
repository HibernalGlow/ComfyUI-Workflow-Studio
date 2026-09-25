/**
 * App-wide UI state shared between views, plus the batch-selection state machine
 * owned by core/batch.js.
 *
 * Views used to pass values to each other through localStorage (`nu_pending_apply`,
 * `nu_pending_workflow`). That is invisible to React, races StrictMode's double
 * render, and leaves stale hand-offs behind; a store with subscriptions fixes all
 * three. Brief §4 note 2 asks for exactly this: "a pure core call + store update".
 */

import { useMemo, useSyncExternalStore } from "react";
import { batch as B } from "core";

export interface ApplyTarget {
    slot: string;
    inputKey: string;
    value: string;
    modelType: string;
    /** Monotonic id so re-applying the same model still notifies. */
    token: number;
}

export interface WorkflowHandoff {
    path: string;
    json: string;
    token: number;
}

export interface AppState {
    applyTarget: ApplyTarget | null;
    /** Models → Generate for embeddings, which go into the prompt, not a node slot. */
    promptAppend: { value: string; target: "positive" | "negative"; token: number } | null;
    workflowHandoff: WorkflowHandoff | null;
    /** The batch state machine lives in core; the store only shares the reference. */
    batch: ReturnType<typeof B.createBatchState>;
}

let state: AppState = {
    applyTarget: null,
    promptAppend: null,
    workflowHandoff: null,
    batch: B.createBatchState(),
};

const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
    for (const fn of listeners) fn();
}

export function getState(): AppState {
    return state;
}

export function setState(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    emit();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Whole-state snapshot, re-rendering on any change. */
export function useApp(): AppState {
    return useSyncExternalStore(subscribe, getState, getState);
}

/** Re-render only when `selector` changes by Object.is. */
export function useAppSlice<T>(selector: (s: AppState) => T): T {
    const snapshot = useSyncExternalStore(subscribe, getState, getState);
    return useMemo(() => selector(snapshot), [snapshot, selector]);
}

/**
 * Models → Generate. Returns false when the type has no slot (embedding goes to the
 * prompt instead, which the caller handles through `appendEmbedding`).
 */
export function requestApply(modelType: string, target: Omit<ApplyTarget, "modelType" | "token">): boolean {
    if (!target.slot) return false;
    setState({ applyTarget: { ...target, modelType, token: ++seq } });
    return true;
}

/**
 * Consume a pending apply. The caller tracks the `token` it last handled in a ref
 * and clears from an effect — clearing during render would re-enter the store.
 */
export function clearApplyTarget(): void {
    if (state.applyTarget) setState({ applyTarget: null });
}

/** Gallery → Workflow. */
export function requestWorkflow(path: string, json: string): void {
    setState({ workflowHandoff: { path, json, token: ++seq } });
}

export function clearWorkflowHandoff(): void {
    if (state.workflowHandoff) setState({ workflowHandoff: null });
}

/**
 * Models → Generate, for the `embedding` type which has no node slot (§4 item 14).
 * `target` mirrors upstream's two side-panel buttons: the negative one only ever renders for
 * embeddings, so the handoff has to say which field to append to.
 */
export function requestPromptAppend(value: string, target: "positive" | "negative" = "positive"): void {
    setState({ promptAppend: { value, target, token: ++seq } });
}

export function clearPromptAppend(): void {
    if (state.promptAppend) setState({ promptAppend: null });
}

/** Replace the shared batch state (core helpers are pure over it). */
export function setBatchState(next: AppState["batch"]): void {
    setState({ batch: next });
}

/** Core mutates the batch state in place; call after a mutation to notify listeners. */
export function touchBatch(): void {
    state = { ...state };
    emit();
}
