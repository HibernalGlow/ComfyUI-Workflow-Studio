/**
 * components/DataTable.js — M3 data table (models view: 9 sortable columns,
 * bulk-action toolbar, pagination-friendly, sticky header via CSS).
 *
 * `createDataTable({ columns, rows, sortKey, sortDir, onSort, rowKey, onRowClick,
 *                    selectable, selectedKeys, onSelectChange, emptyText, dense, toolbar })`
 *   -> `{ root, setRows(rows), setSort(key, dir), getSelected(), setSelected(keys) }`
 *
 *   columns: [{ key, label, sortable?, align?, width?, render?(row), sortValue?(row) }]
 *
 * Sorting is controlled: a sortable `th` (Enter/Space operable, `aria-sort` kept in
 * sync) toggles asc -> desc and fires `onSort(key, dir)`; the caller re-sorts and
 * calls `setRows()` (which preserves the scroll offset). When no `onSort` is given
 * the table sorts locally, using `column.sortValue(row)` when provided.
 *
 * Selection (selectable: true) keeps a Set of `row[rowKey]` keys, exposes a header
 * tri-state checkbox and never prunes keys on `setRows` so cross-page selections
 * survive. Header/row checkboxes are plain `<input type="checkbox">` on purpose —
 * components/Checkbox.js is owned by another agent and must not be imported here.
 *
 * Cell content from `render(row)`: Node / Node[] are appended; a string that looks
 * like markup (`/<[a-z]/i`, same rule as the icon convention) is inserted as HTML —
 * escape user data, `escapeHtml` from core. Row keys are stringified for comparison.
 */

const EMPTY = "m3-data-table__td nu-empty";

function keyOf(row, rowKey, index) {
    if (row && row[rowKey] !== undefined && row[rowKey] !== null) return String(row[rowKey]);
    return String(index);
}

function fill(host, value) {
    if (value === null || value === undefined || value === false) return;
    if (Array.isArray(value)) {
        value.forEach((entry) => fill(host, entry));
        return;
    }
    if (value instanceof Node) {
        host.appendChild(value);
        return;
    }
    const text = String(value);
    if (/<[a-z]/i.test(text)) host.innerHTML = text;
    else host.textContent = text;
}

export function createDataTable({
    columns,
    rows,
    sortKey,
    sortDir,
    onSort,
    rowKey = "id",
    onRowClick,
    selectable = false,
    selectedKeys,
    onSelectChange,
    emptyText,
    dense = false,
    toolbar,
} = {}) {
    const cols = Array.isArray(columns) ? columns : [];
    const root = document.createElement("div");
    root.className = "m3-data-table";
    if (dense) root.style.setProperty("--md-comp-data-table-row-height", "36px");

    let data = Array.isArray(rows) ? rows.slice() : [];
    let key = sortKey === undefined ? null : sortKey;
    let dir = sortDir === "desc" ? "desc" : "asc";
    const selected = new Set(
        selectedKeys instanceof Set ? Array.from(selectedKeys, String)
            : Array.isArray(selectedKeys) ? selectedKeys.map(String)
                : [],
    );

    if (toolbar) {
        const bar = document.createElement("div");
        bar.className = "m3-data-table__toolbar";
        fill(bar, toolbar);
        root.appendChild(bar);
    }

    const scroll = document.createElement("div");
    scroll.className = "m3-data-table__scroll";
    const table = document.createElement("table");
    table.className = "m3-data-table__table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    scroll.appendChild(table);
    root.appendChild(scroll);

    let headCheckbox = null;

    function syncHeadCheckbox() {
        if (!headCheckbox) return;
        let count = 0;
        data.forEach((row, index) => {
            if (selected.has(keyOf(row, rowKey, index))) count += 1;
        });
        headCheckbox.checked = data.length > 0 && count === data.length;
        headCheckbox.indeterminate = count > 0 && count < data.length;
        headCheckbox.disabled = data.length === 0;
    }

    function syncRowState() {
        if (!selectable) return;
        const trs = tbody.querySelectorAll(".m3-data-table__row");
        trs.forEach((tr, index) => {
            const row = data[index];
            if (!row) return;
            const on = selected.has(keyOf(row, rowKey, index));
            if (on) tr.setAttribute("aria-selected", "true");
            else tr.removeAttribute("aria-selected");
            const box = tr.querySelector("input[type=checkbox]");
            if (box) box.checked = on;
        });
        syncHeadCheckbox();
    }

    function fireSelectChange() {
        if (typeof onSelectChange === "function") onSelectChange(Array.from(selected));
    }

    function toggleRow(row, index, force) {
        const rowId = keyOf(row, rowKey, index);
        const next = force === undefined ? !selected.has(rowId) : force;
        if (next) selected.add(rowId);
        else selected.delete(rowId);
        syncRowState();
        fireSelectChange();
    }

    if (selectable) {
        const th = document.createElement("th");
        th.className = "m3-data-table__th";
        th.scope = "col";
        headCheckbox = document.createElement("input");
        headCheckbox.type = "checkbox";
        headCheckbox.setAttribute("aria-label", "Select all rows");
        headCheckbox.addEventListener("change", () => {
            if (headCheckbox.checked) data.forEach((row, index) => selected.add(keyOf(row, rowKey, index)));
            else data.forEach((row, index) => selected.delete(keyOf(row, rowKey, index)));
            syncRowState();
            fireSelectChange();
        });
        th.appendChild(headCheckbox);
        headRow.appendChild(th);
    }

    const heads = cols.map((col) => {
        const th = document.createElement("th");
        th.className = "m3-data-table__th";
        th.scope = "col";
        if (col.align) th.style.textAlign = col.align;
        if (col.width !== undefined && col.width !== null) {
            th.style.width = typeof col.width === "number" ? col.width + "px" : String(col.width);
        }
        th.appendChild(document.createTextNode(col.label === undefined || col.label === null ? col.key : String(col.label)));

        const arrow = document.createElement("span");
        arrow.setAttribute("aria-hidden", "true");
        th.appendChild(arrow);

        if (col.sortable) {
            th.classList.add("m3-data-table__th--sortable");
            th.tabIndex = 0;
            const request = () => toggleSort(col);
            th.addEventListener("click", request);
            th.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                request();
            });
        }

        headRow.appendChild(th);
        return { col, th, arrow };
    });

    function paintHead() {
        heads.forEach(({ col, th, arrow }) => {
            const on = col.sortable && key !== null && col.key === key;
            th.classList.toggle("m3-data-table__th--sorted-asc", Boolean(on && dir === "asc"));
            th.classList.toggle("m3-data-table__th--sorted-desc", Boolean(on && dir === "desc"));
            if (col.sortable) th.setAttribute("aria-sort", on ? (dir === "asc" ? "ascending" : "descending") : "none");
            arrow.textContent = on ? (dir === "asc" ? " \u25B2" : " \u25BC") : "";
        });
    }

    function sortLocal(column) {
        const factor = dir === "asc" ? 1 : -1;
        const pick = (row) => {
            if (column && typeof column.sortValue === "function") return column.sortValue(row);
            return key === null ? undefined : row[key];
        };
        data.sort((a, b) => {
            const va = pick(a);
            const vb = pick(b);
            if (va === vb) return 0;
            if (va === undefined || va === null) return 1;
            if (vb === undefined || vb === null) return -1;
            if (typeof va === "number" && typeof vb === "number") return (va - vb) * factor;
            return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * factor;
        });
    }

    function toggleSort(col) {
        if (key === col.key) dir = dir === "asc" ? "desc" : "asc";
        else {
            key = col.key;
            dir = "asc";
        }
        paintHead();
        if (typeof onSort === "function") onSort(key, dir);
        else setRows(data);
    }

    function renderBody() {
        tbody.textContent = "";
        if (!data.length) {
            const tr = document.createElement("tr");
            tr.className = "m3-data-table__row";
            const td = document.createElement("td");
            td.className = EMPTY;
            td.colSpan = cols.length + (selectable ? 1 : 0);
            td.textContent = emptyText === undefined || emptyText === null ? "" : String(emptyText);
            tr.appendChild(td);
            tbody.appendChild(tr);
            syncHeadCheckbox();
            return;
        }

        data.forEach((row, index) => {
            const rowId = keyOf(row, rowKey, index);
            const tr = document.createElement("tr");
            tr.className = "m3-data-table__row";
            if (selectable && selected.has(rowId)) tr.setAttribute("aria-selected", "true");

            if (selectable) {
                const td = document.createElement("td");
                td.className = "m3-data-table__td";
                const box = document.createElement("input");
                box.type = "checkbox";
                box.checked = selected.has(rowId);
                box.setAttribute("aria-label", "Select " + rowId);
                box.addEventListener("click", (event) => event.stopPropagation());
                box.addEventListener("change", () => toggleRow(row, index, box.checked));
                td.appendChild(box);
                tr.appendChild(td);
            }

            cols.forEach((col) => {
                const td = document.createElement("td");
                td.className = "m3-data-table__td";
                if (col.align) td.style.textAlign = col.align;
                if (typeof col.render === "function") fill(td, col.render(row));
                else {
                    const value = row ? row[col.key] : undefined;
                    if (value instanceof Node) td.appendChild(value);
                    else if (value !== undefined && value !== null) td.textContent = String(value);
                }
                tr.appendChild(td);
            });

            if (selectable || typeof onRowClick === "function") {
                tr.addEventListener("click", (event) => {
                    if (event.target.closest("button, a, input, select, textarea, label")) return;
                    if (selectable) toggleRow(row, index);
                    else if (typeof onRowClick === "function") onRowClick(row, index);
                });
            }

            tbody.appendChild(tr);
        });

        syncHeadCheckbox();
    }

    function setRows(next) {
        const top = scroll.scrollTop;
        const left = scroll.scrollLeft;
        data = Array.isArray(next) ? next.slice() : [];
        if (typeof onSort !== "function" && key !== null) {
            const column = cols.find((col) => col.key === key);
            sortLocal(column);
        }
        renderBody();
        scroll.scrollTop = top;
        scroll.scrollLeft = left;
    }

    paintHead();
    renderBody();

    return {
        root,
        setRows,
        setSort(nextKey, nextDir) {
            key = nextKey === undefined ? null : nextKey;
            if (nextDir === "asc" || nextDir === "desc") dir = nextDir;
            paintHead();
        },
        getSelected() {
            return Array.from(selected);
        },
        setSelected(keys) {
            selected.clear();
            if (keys instanceof Set) keys.forEach((value) => selected.add(String(value)));
            else if (Array.isArray(keys)) keys.forEach((value) => selected.add(String(value)));
            syncRowState();
        },
    };
}
