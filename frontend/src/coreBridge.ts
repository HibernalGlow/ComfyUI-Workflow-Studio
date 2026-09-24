/**
 * The one place that writes the shared `comfyUI` graph state.
 *
 * `core/pipeline.js` reads `comfyUI.currentWorkflow` and `comfyUI.currentAnalysis`
 * (upstream kept them on the client object), but in the upstream JS both are
 * initialised to `null`, so TypeScript infers the literal type `null` and rejects
 * any assignment. Routing every write through here keeps that workaround in one
 * auditable spot instead of scattering casts across the views.
 */

import { comfyUI } from "core";

export interface PromptNode {
    id: string;
    role: string;
    textKey?: string;
}

export interface Analysis {
    prompt_nodes?: PromptNode[];
    [key: string]: unknown;
}

export type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

interface GraphSlot {
    currentWorkflow: unknown;
    currentAnalysis: unknown;
}

export function setClientGraph(workflow: ApiWorkflow | null, analysis: Analysis | null): void {
    const target = comfyUI as unknown as GraphSlot;
    target.currentWorkflow = workflow;
    target.currentAnalysis = analysis;
}

export function getClientGraph(): { workflow: ApiWorkflow | null; analysis: Analysis | null } {
    const source = comfyUI as unknown as GraphSlot;
    return {
        workflow: (source.currentWorkflow as ApiWorkflow | null) ?? null,
        analysis: (source.currentAnalysis as Analysis | null) ?? null,
    };
}
