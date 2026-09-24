/**
 * views/gallery/groups.js — gallery group registry (list / create / rename / delete and
 * add-or-remove a set of image paths).
 *
 * Mirrors the upstream gallery group manager minus the DOM-id wiring: the manager is a
 * dialog owned by this controller, and every mutation goes through `api.*`
 * (`listGalleryGroups`, `createGalleryGroup`, `renameGalleryGroup`, `deleteGalleryGroup`,
 * `bulkGalleryGroup`).
 */

import { api, t } from "../../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createIconButton } from "../../components/IconButton.js";
import { openDialog, confirm, prompt as promptDialog } from "../../dialog.js";
import { showSnackbar } from "../../snackbar.js";

/** Mirrors gallery_routes._RESERVED_GROUPS — the server answers 403 when deleting these. */
const RESERVED_GROUPS = new Set(["__Feeder__", "__Video Assets__", "__Video Temp__"]);

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * @param {{onChanged?:(groups:string[])=>void}} [opts]
 * @returns {{getGroups:()=>string[], refresh:()=>Promise<string[]>, openManager:(paths:string[])=>Promise<void>,
 *            addPaths:(paths:string[], name:string)=>Promise<number>, create:()=>Promise<string|null>,
 *            destroy:()=>void}}
 */
export function createGroupsController(opts = {}) {
    let groups = [];
    let destroyed = false;

    function notify() {
        if (typeof opts.onChanged === "function") opts.onChanged(groups.slice());
    }

    async function refresh() {
        try {
            const data = await api.listGalleryGroups();
            groups = Array.isArray(data && data.groups) ? data.groups.slice() : [];
        } catch (e) {
            if (!destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
            groups = [];
        }
        notify();
        return groups.slice();
    }

    async function create() {
        const name = await promptDialog({ title: "New group", label: "Group name" });
        if (name == null) return null;
        const trimmed = String(name).trim();
        if (!trimmed) return null;
        if (groups.includes(trimmed)) {
            showSnackbar({ label: t("groupExists"), timeout: 4000 });
            return null;
        }
        try {
            await api.createGalleryGroup(trimmed);
            showSnackbar({ label: t("groupCreated", trimmed), timeout: 3500 });
            await refresh();
            return trimmed;
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
            return null;
        }
    }

    async function rename(name) {
        const next = await promptDialog({ title: t("renameGroup"), label: "New name", value: name });
        if (next == null) return false;
        const trimmed = String(next).trim();
        if (!trimmed || trimmed === name) return false;
        try {
            await api.renameGalleryGroup(name, trimmed);
            showSnackbar({ label: `Renamed "${name}" to "${trimmed}"`, timeout: 3500 });
            await refresh();
            return true;
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
            return false;
        }
    }

    async function remove(name) {
        const ok = await confirm({
            title: t("delete"),
            content: `Delete group "${name}"? Images stay in the gallery.`,
            confirmLabel: t("delete"),
            danger: true,
        });
        if (!ok) return false;
        try {
            await api.deleteGalleryGroup(name);
            showSnackbar({ label: t("groupDeleted", name), timeout: 3500 });
            await refresh();
            return true;
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
            return false;
        }
    }

    async function addPaths(paths, name) {
        if (!paths || paths.length === 0) {
            showSnackbar({ label: t("selectGroupFirst"), timeout: 3500 });
            return 0;
        }
        try {
            const res = await api.bulkGalleryGroup(paths, name, "add");
            const count = res && typeof res.ok === "number" ? res.ok : paths.length;
            showSnackbar({ label: t("addedNImagesToGroup", count, name), timeout: 3500 });
            return count;
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
            return 0;
        }
    }

    async function removePaths(paths, name) {
        if (!paths || paths.length === 0) return 0;
        try {
            const res = await api.bulkGalleryGroup(paths, name, "remove");
            const count = res && typeof res.ok === "number" ? res.ok : paths.length;
            showSnackbar({ label: t("removedNImagesFromGroup", count, name), timeout: 3500 });
            return count;
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
            return 0;
        }
    }

    /** Group manager dialog. `paths` is the current grid selection (may be empty). */
    async function openManager(paths) {
        if (destroyed) return;
        const selection = Array.isArray(paths) ? paths : [];
        const content = el("div", "nu-gallery__groups");
        content.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:min(440px,80vw)";

        const selectionNote = el("p", "nu-muted", "");
        const list = el("ul", "m3-list");
        list.style.cssText = "margin:0;padding:0;max-height:46vh;overflow:auto";
        const createBtn = createButton({
            label: "New group",
            variant: "tonal",
            onClick: async () => {
                await create();
                renderRows();
            },
        });
        content.append(selectionNote, list, createBtn);

        function updateNote() {
            selectionNote.textContent = selection.length
                ? `${selection.length} image(s) selected`
                : "No selection — use Add after selecting images in the grid.";
        }

        function renderRows() {
            updateNote();
            list.replaceChildren();
            if (groups.length === 0) {
                list.appendChild(el("li", "nu-empty", "No groups yet."));
                return;
            }
            for (const name of groups) {
                const li = el("li");
                const row = el("div", "m3-list-item nu-gallery__group-row");
                const headline = el("span", "m3-list-item__headline", name);
                const reserved = RESERVED_GROUPS.has(name);
                if (reserved) {
                    headline.appendChild(el("span", "nu-badge", "reserved"));
                }
                const addBtn = createButton({
                    label: "Add",
                    variant: "text",
                    title: `Add selected images to ${name}`,
                    disabled: selection.length === 0,
                    onClick: async () => {
                        await addPaths(selection, name);
                        renderRows();
                    },
                });
                const removeBtn = createButton({
                    label: "Remove",
                    variant: "text",
                    title: `Remove selected images from ${name}`,
                    disabled: selection.length === 0,
                    onClick: async () => {
                        await removePaths(selection, name);
                        renderRows();
                    },
                });
                const renameBtn = createIconButton({
                    icon: "✎",
                    ariaLabel: `${t("renameGroup")} ${name}`,
                    title: t("renameGroup"),
                    onClick: async () => {
                        await rename(name);
                        renderRows();
                    },
                });
                const deleteBtn = createIconButton({
                    icon: "✕",
                    ariaLabel: `${t("delete")} ${name}`,
                    title: reserved ? "Reserved groups cannot be deleted" : t("delete"),
                    disabled: reserved,
                    onClick: async () => {
                        await remove(name);
                        renderRows();
                    },
                });
                row.append(headline, el("span", "nu-spacer"), addBtn, removeBtn, renameBtn, deleteBtn);
                li.appendChild(row);
                list.appendChild(li);
            }
        }

        renderRows();
        await openDialog({
            title: "Gallery groups",
            content,
            actions: [{ label: t("close"), variant: "text" }],
            wide: true,
        });
    }

    function destroy() {
        destroyed = true;
        groups = [];
    }

    refresh();

    return {
        getGroups: () => groups.slice(),
        refresh,
        openManager,
        addPaths,
        create,
        destroy,
    };
}
