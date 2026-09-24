/**
 * components/List.js — M3 list.
 *
 * `createList({ items, dense, onSelect, selectedId })`
 *   -> `{ root, setItems(list), setSelected(id) }`
 *
 *   items: [{ id, headline, supportingText?, leading?, trailing?, selected?, disabled?, onClick? }]
 *
 * Structure: `<ul class="m3-list" role="list">` > `<li>` > `button.m3-list-item`.
 * The `<li>` keeps list semantics while the inner button stays natively focusable
 * and Enter/Space operable. `leading` / `trailing` accept a Node or an icon string
 * (markup-looking strings are inserted as SVG, plain strings as text).
 * Activation calls `item.onClick(item)` and then `onSelect(item.id, item)`.
 * `dense` lowers `--md-comp-list-item-height` instead of inventing a modifier class.
 */

const HEADLINE = "m3-list-item__headline";
const SUPPORTING = "m3-list-item__supporting-text";
const LEADING = "m3-list-item__leading";
const TRAILING = "m3-list-item__trailing";

function fill(host, value) {
    if (value === null || value === undefined || value === false) return false;
    if (value instanceof Node) {
        host.appendChild(value);
        return true;
    }
    const text = String(value);
    if (/<[a-z]/i.test(text)) host.innerHTML = text;
    else host.textContent = text;
    return true;
}

export function createList({ items, dense = false, onSelect, selectedId } = {}) {
    const root = document.createElement("ul");
    root.className = "m3-list";
    root.setAttribute("role", "list");
    if (dense) root.style.setProperty("--md-comp-list-item-height", "40px");

    let selected = selectedId === undefined ? null : selectedId;
    let entries = [];

    function isSelected(item) {
        if (item.selected === true) return true;
        return selected !== null && selected !== undefined && item.id === selected;
    }

    function paint() {
        entries.forEach(({ btn, item }) => {
            const on = isSelected(item);
            btn.classList.toggle("m3-list-item--selected", on);
            if (on) btn.setAttribute("aria-current", "true");
            else btn.removeAttribute("aria-current");
        });
    }

    function build(list) {
        root.textContent = "";
        entries = [];

        (Array.isArray(list) ? list : []).forEach((item) => {
            if (!item) return;

            const li = document.createElement("li");
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "m3-list-item";
            if (item.id !== undefined && item.id !== null) btn.dataset.id = String(item.id);

            if (item.leading !== undefined && item.leading !== null) {
                const leading = document.createElement("span");
                leading.className = LEADING;
                fill(leading, item.leading);
                btn.appendChild(leading);
            }

            // Headline / supporting text are direct children: m3-components.css
            // lays the item out with flex `order` + `flex-wrap` on `.m3-list-item`.
            const headline = document.createElement("span");
            headline.className = HEADLINE;
            fill(headline, item.headline);
            btn.appendChild(headline);

            if (item.supportingText !== undefined && item.supportingText !== null) {
                const supporting = document.createElement("span");
                supporting.className = SUPPORTING;
                fill(supporting, item.supportingText);
                btn.appendChild(supporting);
            }

            if (item.trailing !== undefined && item.trailing !== null) {
                const trailing = document.createElement("span");
                trailing.className = TRAILING;
                fill(trailing, item.trailing);
                btn.appendChild(trailing);
            }

            if (item.disabled) {
                btn.disabled = true;
                btn.setAttribute("aria-disabled", "true");
            }

            btn.addEventListener("click", () => {
                if (item.disabled) return;
                if (typeof item.onClick === "function") item.onClick(item);
                if (typeof onSelect === "function") onSelect(item.id, item);
            });

            li.appendChild(btn);
            root.appendChild(li);
            entries.push({ btn, item });
        });

        paint();
    }

    build(items);

    return {
        root,
        setItems(list) {
            build(list);
        },
        setSelected(id) {
            selected = id === undefined ? null : id;
            paint();
        },
    };
}
