import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_TILES, inCatalogueOrder, type TileId } from "@/features/overview/tiles";

type TilesState = {
    tiles: TileId[];
    setTiles: (tiles: TileId[]) => void;
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
        { name: "x-ui.tiles" },
    ),
);
