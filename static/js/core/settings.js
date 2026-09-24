/**
 * core/settings.js — settings + storage (facade + one new writer)
 *
 * `wfm_settings` is shared with the old UI on purpose (brief §1.2): the new UI
 * inherits the user's already-saved comfyuiUrl / output dir with no migration.
 *
 * NOTE the forbidden key list (brief §10): core must never read or write
 * `wfm_models_view` — that belongs to the old UI's models tab. newui keeps its
 * own view preference under `nu_models_view`.
 */
export { getSettings, readJsonStorage, escapeHtml } from "../util.js";

/** Single settings key shared with the old UI. */
export const SETTINGS_KEY = "wfm_settings";

/**
 * Merge `patch` into the stored settings object and persist it.
 * Returns the merged object. Never throws (a full/disabled localStorage is
 * reported through the return value's `__error` field instead).
 *
 * @param {object} patch
 * @returns {object} the merged settings
 */
export function updateSettings(patch) {
    const merged = { ...readSettingsRaw(), ...(patch || {}) };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch (err) {
        merged.__error = err?.message || "localStorage write failed";
    }
    return merged;
}

/** Raw settings read that does not swallow the reason for a parse failure. */
export function readSettingsRaw() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/**
 * Read a namespaced new-UI preference. Keys are automatically prefixed with
 * `nu_` so newui can never collide with an old-UI key.
 * @param {string} name  e.g. "models_view"
 * @param {*} fallback
 */
export function readPref(name, fallback = null) {
    try {
        const raw = localStorage.getItem(`nu_${name}`);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

/**
 * Write a namespaced new-UI preference.
 * @param {string} name
 * @param {*} value
 */
export function writePref(name, value) {
    try {
        localStorage.setItem(`nu_${name}`, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

/** The new UI's own settings key (NOT `wfm_settings`). */
export const PREFS_PREFIX = "nu_";
