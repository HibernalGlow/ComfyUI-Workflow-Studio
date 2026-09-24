import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted, so the Material Symbols ligatures md-icon renders work offline.
// md-icon's own sheet reads `var(--md-icon-font, Material Symbols Outlined)`.
import "material-symbols/outlined.css";
import "./theme.css";
import App from "./App.js";
import { comfyUI, getSettings } from "core";

/*
 * Boot order matters: every core request resolves against comfyUI.baseUrl/wsUrl,
 * and those come from the `wfm_settings` localStorage entry the old UI also
 * writes. Same origin as /wfm, so the address the user already saved is inherited
 * as-is (brief §1.2).
 */
const saved = getSettings();
comfyUI.updateUrl(saved.comfyuiUrl || window.location.origin);

const container = document.getElementById("nu-root");
if (!container) throw new Error("#nu-root is missing from newui.html");

createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
