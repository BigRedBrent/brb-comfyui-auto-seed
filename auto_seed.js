import { app } from "../../scripts/app.js";

const LOG_PREFIX = "[Auto Seed]";

// Wait this long after a workflow loads, so ComfyUI finishes its own steps first.
const DELAY_AFTER_LOAD_MS = 300;

// The same limits ComfyUI uses when it randomizes a seed after a run.
const LARGEST_SEED = 1125899906842624;

// How many subgraphs deep to look when a subgraph's field passes its number further inside.
const MAX_SUBGRAPH_DEPTH = 10;

// Both options are kept in ComfyUI's own settings (saved in comfy.settings.json in the ComfyUI user folder),
// so every browser shares them. They appear together in the Settings window under "Auto Seed".
const SETTING_ENABLED = "AutoSeed.Enabled";
const SETTING_SHOW_SWITCH = "AutoSeed.ShowToolbarSwitch";

const TOGGLE_ID = "auto-seed-toggle";

// Where an earlier version kept the on/off state in the browser. Moved into ComfyUI's settings once.
const OLD_BROWSER_STORAGE_KEY = "AutoSeed.enabled";

function getSetting(id, fallback) {
    try {
        const settings = app.extensionManager?.setting;
        if (settings && typeof settings.get === "function") {
            const value = settings.get(id);
            return value === undefined || value === null ? fallback : value;
        }
        const value = app.ui?.settings?.getSettingValue?.(id);
        return value === undefined || value === null ? fallback : value;
    } catch (error) {
        return fallback;
    }
}

async function setSetting(id, value) {
    try {
        const settings = app.extensionManager?.setting;
        if (settings && typeof settings.set === "function") {
            await settings.set(id, value);
            return;
        }
        await app.ui?.settings?.setSettingValueAsync?.(id, value);
    } catch (error) {
        console.error(`${LOG_PREFIX} Couldn't save the setting:`, error);
    }
}

function autoSeedOn() {
    return getSetting(SETTING_ENABLED, true) !== false;
}

function switchShown() {
    return getSetting(SETTING_SHOW_SWITCH, true) !== false;
}

async function moveOldBrowserSetting() {
    // If an earlier version saved "off" in this browser, carry it over to ComfyUI's settings, then forget it here.
    try {
        const old = localStorage.getItem(OLD_BROWSER_STORAGE_KEY);
        if (old === null) {
            return;
        }
        localStorage.removeItem(OLD_BROWSER_STORAGE_KEY);
        if (old === "false") {
            await setSetting(SETTING_ENABLED, false);
        }
    } catch (error) {
        // Nothing to carry over.
    }
}

function allGraphs() {
    // The main graph plus the inside of every subgraph, found both from the workflow's list of subgraphs
    // and by looking inside each subgraph node, including subgraphs within subgraphs.
    const found = new Set();
    const pending = [app.graph];
    const subgraphs = app.graph?.subgraphs;
    if (subgraphs && typeof subgraphs.values === "function") {
        for (const subgraph of subgraphs.values()) {
            pending.push(subgraph);
        }
    }
    while (pending.length > 0) {
        const graph = pending.pop();
        if (!graph || found.has(graph)) {
            continue;
        }
        found.add(graph);
        for (const node of nodesIn(graph)) {
            if (node.subgraph) {
                pending.push(node.subgraph);
            }
        }
    }
    return Array.from(found);
}

function nodesIn(graph) {
    return graph.nodes || graph._nodes || [];
}

const CONTROL_CHOICES = ["fixed", "increment", "decrement", "randomize"];

function isControlWidget(widget) {
    // Usually named "control_after_generate", but on some nodes the name shows up as "fixed" instead,
    // so it's also recognized by its choices.
    if (!widget) {
        return false;
    }
    const name = String(widget.name || "");
    if (name.startsWith("control_")) {
        return true;
    }
    const choices = widget.options?.values;
    if (Array.isArray(choices) && choices.includes("randomize") && choices.includes("fixed")) {
        return true;
    }
    return CONTROL_CHOICES.includes(name) && CONTROL_CHOICES.includes(widget.value);
}

function ownControl(node, widget) {
    // A seed field's "control after generate" setting is a separate widget linked to it,
    // normally placed right after it on the node.
    const linked = (widget.linkedWidgets || []).find(isControlWidget);
    if (linked) {
        return linked;
    }
    const widgets = node.widgets || [];
    const next = widgets[widgets.indexOf(widget) + 1];
    return isControlWidget(next) ? next : null;
}

function findLink(graph, linkId) {
    const links = graph.links || graph._links;
    if (!links) {
        return null;
    }
    if (typeof links.get === "function") {
        return links.get(linkId) || null;
    }
    return links[linkId] || null;
}

function findNode(graph, nodeId) {
    if (typeof graph.getNodeById === "function") {
        return graph.getNodeById(nodeId);
    }
    return nodesIn(graph).find((node) => node.id === nodeId) || null;
}

function innerFields(subgraphNode, widget) {
    // For a field on the outside of a subgraph, find the fields inside it that its number is passed to.
    const subgraph = subgraphNode.subgraph;
    if (!subgraph) {
        return [];
    }
    const outerInput = (subgraphNode.inputs || []).find(
        (input) => input.widget && input.widget.name === widget.name
    );
    const inputName = outerInput ? outerInput.name : widget.name;
    const subgraphInput = (subgraph.inputs || []).find((input) => input.name === inputName);
    if (!subgraphInput) {
        return [];
    }
    const fields = [];
    for (const linkId of subgraphInput.linkIds || []) {
        const link = findLink(subgraph, linkId);
        if (!link) {
            continue;
        }
        const targetNode = findNode(subgraph, link.target_id);
        const targetInput = targetNode?.inputs?.[link.target_slot];
        const widgetName = targetInput?.widget?.name;
        const targetWidget = widgetName ? (targetNode.widgets || []).find((w) => w.name === widgetName) : null;
        if (targetWidget) {
            fields.push({ node: targetNode, widget: targetWidget });
        }
    }
    return fields;
}

function randomizeTarget(node, widget, depth = 0) {
    // Returns the field whose limits apply if this field is set to randomize, otherwise null.
    // A subgraph's outside field may have no setting of its own; then the setting of the field
    // inside the subgraph that it feeds is used.
    const control = ownControl(node, widget);
    if (control) {
        return control.value === "randomize" ? widget : null;
    }
    if (depth >= MAX_SUBGRAPH_DEPTH) {
        return null;
    }
    for (const inner of innerFields(node, widget)) {
        const innerTarget = randomizeTarget(inner.node, inner.widget, depth + 1);
        if (innerTarget) {
            return innerTarget;
        }
    }
    return null;
}

function isWired(node, widget) {
    // A field that gets its number through a wire, from another node or from a subgraph's input, is left exactly as it is.
    const inputs = node.inputs || [];
    const slot = inputs.findIndex((input) => input.widget && input.widget.name === widget.name);
    if (slot === -1) {
        return false;
    }
    if (typeof node.isInputConnected === "function") {
        return node.isInputConnected(slot);
    }
    // Older versions of ComfyUI.
    return inputs[slot].link != null;
}

function randomValueFor(widget, limitsFrom) {
    // Stay within both this field's limits and those of the field it feeds.
    const options = widget.options || {};
    const innerOptions = limitsFrom.options || {};
    let min = -LARGEST_SEED;
    let max = LARGEST_SEED;
    for (const source of [options, innerOptions]) {
        if (typeof source.min === "number") {
            min = Math.max(min, source.min);
        }
        if (typeof source.max === "number") {
            max = Math.min(max, source.max);
        }
    }
    if (typeof options.min !== "number" && typeof innerOptions.min !== "number") {
        min = 0;
    }
    let step = 1;
    for (const source of [innerOptions, options]) {
        if (typeof source.step2 === "number" && source.step2 > 0) {
            step = source.step2;
            break;
        }
        if (typeof source.step === "number" && source.step > 0) {
            step = source.step / 10;
            break;
        }
    }
    if (step <= 0) {
        step = 1;
    }
    const range = (max - min) / step;
    return Math.floor(Math.random() * range) * step + min;
}

function randomizeSeeds() {
    let changed = 0;
    for (const graph of allGraphs()) {
        for (const node of nodesIn(graph)) {
            for (const widget of node.widgets || []) {
                if (typeof widget.value !== "number" || isWired(node, widget)) {
                    continue;
                }
                const limitsFrom = randomizeTarget(node, widget);
                if (!limitsFrom) {
                    continue;
                }
                widget.value = randomValueFor(widget, limitsFrom);
                if (typeof widget.callback === "function") {
                    widget.callback(widget.value);
                }
                changed += 1;
            }
        }
    }
    if (changed > 0) {
        app.graph.setDirtyCanvas(true, true);
    }
    return changed;
}

// Open tabs that have already had new seeds picked. Each time a workflow is opened, ComfyUI gives it a
// new change tracker (its undo history), which stays the same while the tab stays open. So switching back
// to a tab is recognized and skipped, while closing and reopening a workflow, or refreshing the page,
// counts as opening it again. (The workflow itself can't be used for this: ComfyUI keeps the same
// workflow object for a saved file even after its tab is closed.)
const tabsWithNewSeeds = new WeakSet();

function afterLoad() {
    const workflow = app.extensionManager?.workflow?.activeWorkflow;
    const openedAs = workflow ? workflow.changeTracker || workflow : null;
    if (openedAs && tabsWithNewSeeds.has(openedAs)) {
        // Just switching back to this tab.
        return;
    }
    if (openedAs) {
        tabsWithNewSeeds.add(openedAs);
    }
    // The new seeds count as a normal change, so the workflow shows as having unsaved changes.
    const changed = randomizeSeeds();
    if (changed > 0) {
        console.log(`${LOG_PREFIX} Workflow opened, then picked ${changed} new seed(s)`);
    }
}

// ---- The Auto Seed switch, to the right of Extensions ----

function findButtonByText(text) {
    for (const button of document.querySelectorAll("button")) {
        if (button.closest(`#${TOGGLE_ID}`)) {
            continue;
        }
        if (button.textContent.trim() === text) {
            return button;
        }
    }
    return null;
}

function outermostWrapper(button) {
    // Walk up through everything that belongs only to this button, stopping where other buttons are.
    let element = button;
    while (element.parentElement) {
        const neighbors = Array.from(element.parentElement.querySelectorAll("button")).filter(
            (other) => !other.closest(`#${TOGGLE_ID}`) && !element.contains(other)
        );
        if (neighbors.length > 0) {
            break;
        }
        element = element.parentElement;
    }
    return element;
}

function updateToggle() {
    const container = document.getElementById(TOGGLE_ID);
    if (!container) {
        return;
    }
    const on = autoSeedOn();
    const icon = container.querySelector("i");
    if (icon) {
        icon.className = on ? "pi pi-check-square" : "pi pi-stop";
    }
    const button = container.querySelector("button");
    if (button) {
        button.title = on
            ? "Auto Seed is on: new seeds are picked whenever a workflow opens. Click to turn off."
            : "Auto Seed is off: seeds are only changed by ComfyUI after a run. Click to turn on.";
        button.setAttribute("aria-pressed", on ? "true" : "false");
    }
}

function createToggle(extensionsButton, extensionsWrapper) {
    // A separate box styled like the one Extensions is in, holding a button styled like Extensions.
    const container = extensionsWrapper === extensionsButton
        ? document.createElement("span")
        : document.createElement(extensionsWrapper.tagName);
    container.id = TOGGLE_ID;
    if (extensionsWrapper !== extensionsButton) {
        container.className = extensionsWrapper.className;
    }
    container.style.marginLeft = "4px";

    const button = document.createElement("button");
    button.type = "button";
    button.className = extensionsButton.className;
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.gap = "6px";

    const icon = document.createElement("i");
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Auto Seed";

    button.appendChild(icon);
    button.appendChild(label);
    const keepClickToItself = (event) => event.stopPropagation();
    button.addEventListener("pointerdown", keepClickToItself);
    button.addEventListener("mousedown", keepClickToItself);
    button.addEventListener("click", async (event) => {
        keepClickToItself(event);
        event.preventDefault();
        await setSetting(SETTING_ENABLED, !autoSeedOn());
        updateToggle();
    });
    container.appendChild(button);
    return container;
}

function insertToggle() {
    if (!switchShown()) {
        // Hidden by the "Show the Auto Seed switch" setting. Auto Seed itself still works as set.
        document.getElementById(TOGGLE_ID)?.remove();
        return;
    }
    const extensionsButton = findButtonByText("Extensions");
    if (!extensionsButton) {
        return;
    }
    const wrapper = outermostWrapper(extensionsButton);
    let container = document.getElementById(TOGGLE_ID);
    if (!container) {
        container = createToggle(extensionsButton, wrapper);
        updateToggle();
    } else {
        // Keep matching the style of Extensions if the interface restyles it.
        const button = container.querySelector("button");
        if (button && button.className !== extensionsButton.className) {
            button.className = extensionsButton.className;
        }
        if (wrapper !== extensionsButton && container.className !== wrapper.className) {
            container.className = wrapper.className;
        }
    }
    if (wrapper.nextSibling !== container) {
        wrapper.parentElement.insertBefore(container, wrapper.nextSibling);
        updateToggle();
    }
}

let scheduled = false;

function scheduleInsert() {
    if (scheduled) {
        return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        insertToggle();
    });
}

app.registerExtension({
    name: "AutoSeed",
    settings: [
        {
            id: SETTING_ENABLED,
            category: ["Auto Seed", "Auto Seed", "Enabled"],
            name: "Pick new seeds when a workflow opens",
            tooltip:
                "Gives every seed field set to randomize a new number when a workflow opens: opening one, " +
                "refreshing, or dropping in an image. Switching back to an open tab doesn't change them. " +
                "Wired fields and fixed seeds are left alone.",
            type: "boolean",
            defaultValue: true,
            onChange: () => updateToggle(),
        },
        {
            id: SETTING_SHOW_SWITCH,
            category: ["Auto Seed", "Auto Seed", "Show switch"],
            name: "Show the Auto Seed switch in the toolbar",
            tooltip: "Shows the Auto Seed on/off switch to the right of Extensions. The option above works either way.",
            type: "boolean",
            defaultValue: true,
            onChange: () => scheduleInsert(),
        },
    ],
    async setup() {
        await moveOldBrowserSetting();
        // Add the switch, and keep it in place if the toolbar is rebuilt or restyled.
        insertToggle();
        const observer = new MutationObserver(scheduleInsert);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
        });
    },
    afterConfigureGraph() {
        // Runs whenever a workflow is loaded: opening one, switching tabs, refreshing, or dropping in an image.
        // Switching back to a tab that already got new seeds is skipped in afterLoad.
        if (!autoSeedOn()) {
            return;
        }
        setTimeout(() => {
            try {
                afterLoad();
            } catch (error) {
                console.error(`${LOG_PREFIX} Couldn't pick new seeds:`, error);
            }
        }, DELAY_AFTER_LOAD_MS);
    },
});
