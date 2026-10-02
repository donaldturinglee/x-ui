// What the overview can be made of, and what the picker offers.
//
// An id says how a tile is drawn as well as what it reads: `g-` is a gauge, `h-`
// a chart of the last few readings and `i-` a panel of figures. The ids are what
// a selection is stored under, so they outlive the titles beside them -- renaming
// one here would empty the tile it stood for on every panel that had picked it.

export type GaugeTileId = "g-cpu" | "g-mem" | "g-dsk" | "g-swp";

export type ChartTileId = "h-cpu" | "h-mem" | "h-net" | "hp-net";

export type InfoTileId = "i-panel" | "i-sys" | "i-core";

export type TileId = GaugeTileId | ChartTileId | InfoTileId;

export interface TileGroup {
    title: string;
    tiles: { id: TileId; title: string }[];
}

// Grouped by what a tile is rather than by what it reads, which is how the
// picker reads: an operator is choosing between a dial and a graph of the same
// figure as often as between two figures.
export const TILE_GROUPS: TileGroup[] = [
    {
        title: "Gauges",
        tiles: [
            { id: "g-cpu", title: "CPU gauge" },
            { id: "g-mem", title: "Memory gauge" },
            { id: "g-dsk", title: "Disk gauge" },
            { id: "g-swp", title: "Swap gauge" },
        ],
    },
    {
        title: "Charts",
        tiles: [
            { id: "h-cpu", title: "CPU monitor" },
            { id: "h-mem", title: "Memory monitor" },
            { id: "h-net", title: "Network bandwidth" },
            { id: "hp-net", title: "Network packets" },
        ],
    },
    {
        title: "Information",
        tiles: [
            { id: "i-sys", title: "System info" },
            { id: "i-panel", title: "Panel info" },
            { id: "i-core", title: "sing-box" },
        ],
    },
];

const TILES = TILE_GROUPS.flatMap((group) => group.tiles);

export const tileTitle = (id: TileId) => TILES.find((tile) => tile.id === id)?.title ?? id;

// Kept in the order the picker lists them rather than the order they were
// turned on, so a tile switched off and on again comes back where it was.
export const inCatalogueOrder = (ids: Iterable<TileId>) => {
    const picked = new Set(ids);

    return TILES.filter((tile) => picked.has(tile.id)).map((tile) => tile.id);
};

// What a panel nobody has set up shows. Everything the API answers with is on,
// because an overview that started empty would be read as a panel that knows
// nothing rather than as one that was never asked; an operator who wants less
// turns tiles off rather than having to find them.
export const DEFAULT_TILES: TileId[] = inCatalogueOrder([
    "i-panel",
    "i-sys",
    "i-core",
    "g-cpu",
    "g-mem",
    "g-dsk",
    "g-swp",
    "h-cpu",
    "h-mem",
    "h-net",
    "hp-net",
]);
