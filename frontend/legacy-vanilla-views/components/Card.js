/**
 * Card.js — M3 card container. A card with `onClick` becomes a keyboard
 * reachable button (role + Enter/Space), since a bare div is not focusable.
 */
const VARIANTS = ["elevated", "filled", "outlined"];

function appendChildren(parent, children) {
    if (children == null) return;
    if (Array.isArray(children)) {
        for (const child of children) appendChildren(parent, child);
    } else if (children instanceof Node) {
        parent.append(children);
    } else {
        parent.append(document.createTextNode(String(children)));
    }
}

export function createCard({ variant = "elevated", children, onClick } = {}) {
    const card = document.createElement("div");
    card.className = `m3-card m3-card--${VARIANTS.includes(variant) ? variant : "elevated"}`;
    appendChildren(card, children);

    if (typeof onClick === "function") {
        card.setAttribute("role", "button");
        if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "0");
        card.addEventListener("click", onClick);
        card.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onClick(event);
        });
    }
    return card;
}
