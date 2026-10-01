import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "@testing-library/jest-dom/vitest";

// Components that lay themselves out against the room they are given watch for
// it to change, and jsdom has nothing to watch with. Nothing is ever laid out
// here for a size to be read back from, so observing is all this has to do.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

// Restoring the scroll position is something jsdom has no window to do it to,
// and it is left unimplemented rather than absent, so it is replaced outright.
window.scrollTo = () => {};

// Node ships a `localStorage` of its own, which only holds anything when the
// runtime was started with a file to keep it in. It was not, so its getter sits
// on the global in front of the one jsdom would have put there and hands back
// nothing at all, which leaves a store that persists itself writing to
// undefined. Nothing here needs what was written to outlive the test that wrote
// it, so keeping it in memory is all this has to do.
if (!globalThis.localStorage) {
    const entries = new Map<string, string>();

    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            get length() {
                return entries.size;
            },
            key: (index: number) => [...entries.keys()][index] ?? null,
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => {
                entries.set(key, String(value));
            },
            removeItem: (key: string) => {
                entries.delete(key);
            },
            clear: () => entries.clear(),
        } satisfies Storage,
    });
}

// Vitest is not run with globals, so there is no `afterEach` in scope for
// Testing Library to hang its own cleanup on. Without one, whatever a test
// rendered is left in the document for the next test to find.
afterEach(() => {
    cleanup();

    // Overlays are portalled into an element the design system keeps hold of for
    // as long as it is still in the document. The one it falls back to making
    // sits on the body rather than in what was rendered, so it outlives the tree
    // that caused it and the next test would be handed it again.
    document.querySelectorAll(".portal-root").forEach((root) => root.remove());
});
