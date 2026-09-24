/**
 * core/client.js — ComfyUI /prompt transport (facade)
 *
 * Re-exports the upstream client object unchanged. `comfyUI` internally uses
 * fetch + WebSocket only (3 DOM touches in upstream, none of them DOM APIs).
 * core/newui must NOT re-implement any of this.
 */
export { comfyUI } from "../comfyui-client.js";
