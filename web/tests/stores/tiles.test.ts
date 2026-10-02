import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_TILES, TILE_GROUPS, tileTitle } from "@/features/overview/tiles";
import { migrateTiles, useTilesStore } from "@/stores/tiles";

describe("tile catalogue", () => {
    it("offers every tile the overview can draw, once", () => {
        const ids = TILE_GROUPS.flatMap((group) => group.tiles.map((tile) => tile.id));

        // A tile listed twice would be a switch that fights with itself, and one
        // listed nowhere is a tile nobody can turn on.
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(expect.arrayContaining(DEFAULT_TILES));
    });

    it("names a tile the way the picker does", () => {
        expect(tileTitle("g-cpu")).toBe("CPU gauge");
    });
});

describe("tiles store", () => {
    beforeEach(() => {
        useTilesStore.setState({ tiles: DEFAULT_TILES });
    });

    it("shows the readings the panel has without being set up", () => {
        // An overview that started empty would be read as a panel that knows
        // nothing rather than one that was never asked.
        expect(useTilesStore.getState().tiles.length).toBeGreaterThan(0);
    });

    it("keeps a picked tile where the picker has it", () => {
        // Order the switches were flipped in is not an order anybody chose, so a
        // tile switched off and on again comes back where it was rather than
        // moving to the end.
        useTilesStore.getState().setTiles(["i-sys", "g-mem"]);

        expect(useTilesStore.getState().tiles).toEqual(["g-mem", "i-sys"]);
    });

    it("adds the core card to an existing selection without restoring hidden cards", () => {
        expect(migrateTiles({ tiles: ["i-sys", "g-mem", "unknown"] }).tiles).toEqual([
            "g-mem",
            "i-sys",
            "i-core",
        ]);
    });

    it("adds the core card when all old cards were hidden", () => {
        expect(migrateTiles({ tiles: [] }).tiles).toEqual(["i-core"]);
    });

    it("uses defaults for an invalid stored selection", () => {
        expect(migrateTiles(null).tiles).toEqual(DEFAULT_TILES);
    });
});
