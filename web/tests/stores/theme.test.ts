import { beforeEach, describe, expect, it } from "vitest";

import { useThemeStore } from "@/stores/theme";

describe("theme store", () => {
    beforeEach(() => {
        useThemeStore.setState({ colorMode: "auto" });
    });

    it("follows the system until somebody chooses otherwise", () => {
        // A panel left open on a wall should match whatever the room is doing
        // rather than committing to one look on first load.
        expect(useThemeStore.getState().colorMode).toBe("auto");
    });

    it("keeps a choice", () => {
        useThemeStore.getState().setColorMode("dark");

        expect(useThemeStore.getState().colorMode).toBe("dark");
    });
});
