/**
 * core/client.js — ComfyUI /prompt transport (facade)
 *
 * Re-exports the upstream client object unchanged. `comfyUI` internally uses
 * fetch + WebSocket only (3 DOM touches in upstream, none of them DOM APIs).
 * core/newui must NOT re-implement any of this.
 */
export { comfyUI } from "../comfyui-client.js";

/**
 * Upstream v0.7.13 reports the pre-generation VRAM unload through a toast helper. The old UI's is
 * in app.js, which the new UI must never load, so the React shell injects its own sink. An
 * unregistered caller still does the work — it just stays quiet.
 */
export { setVramToastSink } from "../vram-prepare.js";
