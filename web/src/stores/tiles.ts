import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
    DEFAULT_TILES,
    TILE_GROUPS,
    inCatalogueOrder,
    type TileId,
} from "@/features/overview/tiles";

type TilesState = {
    tiles: TileId[];
    setTiles: (tiles: TileId[]) => void;
};

export const migrateTiles = (stored: unknown) => {
    const saved =
        stored && typeof stored === "object" && "tiles" in stored ? stored.tiles : undefined;
    const known = new Set(TILE_GROUPS.flatMap((group) => group.tiles.map((tile) => tile.id)));
    const picked = Array.isArray(saved)
        ? saved.filter((id): id is TileId => known.has(id))
        : DEFAULT_TILES;
    return { tiles: inCatalogueOrder([...picked, "i-core"]) };
};

// Which tiles the overview is showing. It is kept in the browser rather than on
// the panel: what one operator wants to watch is not what the next one does, and
// the reading behind a tile is the same for everyone anyway.
export const useTilesStore = create<TilesState>()(
    persist(
        (set) => ({
            tiles: DEFAULT_TILES,
            setTiles: (tiles) => set({ tiles: inCatalogueOrder(tiles) }),
        }),
        { name: "x-ui.tiles", version: 1, migrate: migrateTiles },
    ),
);
