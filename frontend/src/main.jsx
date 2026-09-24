import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import App from "./App.jsx";
import { comfyUI, getSettings } from "core";

/*
 * Boot order matters: every core request resolves against comfyUI.baseUrl/wsUrl,
 * and those come from the `wfm_settings` localStorage entry the old UI also
 * writes. Same origin as /wfm, so the user's saved address is inherited as-is.
 */
const saved = getSettings();
comfyUI.updateUrl(saved.comfyuiUrl || window.location.origin);

createRoot(document.getElementById("nu-root")).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
