import { beforeEach, describe, expect, it } from "vitest";

import { useSidebarStore } from "@/stores/sidebar";

describe("sidebar store", () => {
    beforeEach(() => {
        useSidebarStore.setState({ isExpanded: false, foldedGroups: [] });
    });

    it("keeps the rail to its icons until somebody expands it", () => {
        // The page gets the room until an operator asks for the labels.
        expect(useSidebarStore.getState().isExpanded).toBe(false);
    });

    it("expands the rail, and collapses it again", () => {
        useSidebarStore.getState().expand();

        expect(useSidebarStore.getState().isExpanded).toBe(true);

        useSidebarStore.getState().collapse();

        expect(useSidebarStore.getState().isExpanded).toBe(false);
    });

    it("starts every group open, and folds and unfolds one at a time", () => {
        expect(useSidebarStore.getState().foldedGroups).toEqual([]);

        useSidebarStore.getState().toggleGroup("General");
        useSidebarStore.getState().toggleGroup("Other");

        expect(useSidebarStore.getState().foldedGroups).toEqual(["General", "Other"]);

        useSidebarStore.getState().toggleGroup("General");

        expect(useSidebarStore.getState().foldedGroups).toEqual(["Other"]);
    });
});
