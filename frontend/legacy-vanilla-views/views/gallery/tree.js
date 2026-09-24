/**
 * views/gallery/tree.js — lazy folder tree of the Gallery view.
 *
 * The tree data comes from `api.listGalleryFolders(root)` in one shot (the backend walks
 * the whole subtree), but the DOM is built on demand: a node's children are only created
 * when the node is expanded, so a deep output directory stays cheap to render.
 *
 * Usage: `const tree = createFolderTree({ onSelect }); tree.root; tree.setTree(node);
 * tree.setCurrent(absPath);`
 */

import { t } from "../../../core/index.js";
import { createIconButton } from "../../components/IconButton.js";

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * @param {{onSelect:(absPath:string, isRoot:boolean)=>void}} opts
 * @returns {{root:HTMLElement, setTree:(node:object|null)=>void, getTree:()=>object|null,
 *            setCurrent:(absPath:string)=>void, resetExpansion:()=>void, expandRoot:()=>void,
 *            destroy:()=>void}}
 */
export function createFolderTree(opts) {
    const root = el("ul", "nu-gallery__tree");
    root.setAttribute("aria-label", "Output folders");
    root.style.cssText = "list-style:none;margin:0;padding:0;max-height:62vh;overflow:auto";

    let tree = null;
    let current = "";
    const expanded = new Set();
    let destroyed = false;

    function render() {
        if (destroyed) return;
        root.replaceChildren();
        if (!tree) {
            root.appendChild(el("li", "nu-empty", t("loading")));
            return;
        }
        root.appendChild(nodeEl(tree, 0, true));
    }

    function nodeEl(node, depth, isRoot) {
        const li = el("li");
        const row = el("div", "nu-gallery__tree-row");
        row.style.cssText = `display:flex;align-items:center;gap:2px;padding-inline-start:${depth * 12}px`;
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const isExpanded = expanded.has(node.abs_path);
        const name = isRoot ? "[root]" : String(node.name || "");

        const toggle = createIconButton({
            icon: isExpanded ? "▾" : "▸",
            ariaLabel: `${isExpanded ? "Collapse" : "Expand"} ${name}`,
            title: hasChildren ? "Expand / collapse" : "No subfolders",
            disabled: !hasChildren,
            onClick: () => {
                if (isExpanded) expanded.delete(node.abs_path);
                else expanded.add(node.abs_path);
                render();
            },
        });

        const label = el("button", "nu-gallery__tree-label");
        label.type = "button";
        label.style.cssText =
            "flex:1 1 auto;display:flex;align-items:center;gap:6px;text-align:start;" +
            "background:none;border:0;padding:4px 6px;cursor:pointer;min-width:0";
        label.append(el("span", "nu-gallery__tree-name", name));
        if (node.image_count > 0) label.appendChild(el("span", "nu-badge", String(node.image_count)));
        if (current === node.abs_path) {
            li.classList.add("nu-gallery__tree-item--selected");
            label.setAttribute("aria-current", "true");
        }
        label.addEventListener("click", () => {
            if (typeof opts.onSelect === "function") opts.onSelect(node.abs_path, isRoot);
        });

        row.append(toggle, label);
        li.appendChild(row);
        if (hasChildren && isExpanded) {
            const sub = el("ul", "nu-gallery__tree-children");
            sub.style.cssText = "list-style:none;margin:0;padding:0";
            for (const child of node.children) sub.appendChild(nodeEl(child, depth + 1, false));
            li.appendChild(sub);
        }
        return li;
    }

    function setTree(node) {
        tree = node && !node.error ? node : null;
        if (tree && tree.abs_path) expanded.add(tree.abs_path);
        render();
    }

    return {
        root,
        setTree,
        getTree: () => tree,
        setCurrent: (absPath) => { current = absPath || ""; render(); },
        resetExpansion: () => { expanded.clear(); },
        expandRoot: () => {
            if (tree && tree.abs_path) {
                expanded.add(tree.abs_path);
                render();
            }
        },
        destroy: () => {
            destroyed = true;
            tree = null;
            expanded.clear();
            root.replaceChildren();
        },
    };
}

export default createFolderTree;
