/**
 * core/i18n.js — i18n (facade + one fallback helper)
 *
 * Decision 4: reuse the upstream dictionary verbatim so every upstream commit
 * that adds a translation key is inherited for free. No new dictionary file.
 *
 * IMPORTANT: upstream `t(key, ...args)` does **not** take a fallback — the
 * variadic arguments are `{0}`, `{1}`-style substitutions, and a missing key
 * comes back as the key itself. The brief's `t("key", "fallback")` form would
 * therefore render the raw key, so `tr(key, fallback)` exists below for text
 * that is new in newui. Prefer `t()` for anything upstream already translates.
 */
export {
    t,
    initI18n,
    getLang,
    setLang,
    getLanguageOptions,
    getSummaryPrompt,
    getSummaryLang,
    setSummaryLang,
    getSummaryLanguageOptions,
} from "../i18n.js";

import { t } from "../i18n.js";

/**
 * Translate with a real fallback: returns `fallback` when upstream has no entry
 * for `key` (upstream `t` returns the key in that case).
 * @param {string} key
 * @param {string} fallback
 * @param {...any} args `{0}`-style substitutions, forwarded to `t`
 * @returns {string}
 */
export function tr(key, fallback, ...args) {
    const value = t(key, ...args);
    return value === key ? fallback : value;
}
