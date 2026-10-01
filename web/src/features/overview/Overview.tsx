import { Avatar, Button } from "@gamecrafters/base-ui/react";
import {
    DataBarVerticalRegular,
    DocumentBulletListRegular,
    HistoryRegular,
    StarAddRegular,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { settings } from "@/settings";
import { useTilesStore } from "@/stores/tiles";

import { useMaintenance } from "./api";
import { BackupDialog } from "./components/BackupDialog";
import { CountsDialog } from "./components/CountsDialog";
import { GaugeTile } from "./components/GaugeTile";
import { HistoryTile } from "./components/HistoryTile";
import { LogsDialog } from "./components/LogsDialog";
import { PanelInfoTile } from "./components/PanelInfoTile";
import { SystemInfoTile } from "./components/SystemInfoTile";
import { TilesDialog } from "./components/TilesDialog";
import { type TileId } from "./tiles";

type DialogName = "tiles" | "backup" | "logs" | "counts";

// A tinted box rather than an outlined one, with the mark standing against the
// label rather than spaced off it, which is the shape the reference gives the
// row of things the page can be asked for.
const BUTTON_CLASS =
    "inline-flex h-9 rounded-[4px] border-0 bg-[var(--control-transparent-background-color-selected)] px-4 text-[14px] shadow-[var(--shadow-resting-medium)] [&_[data-component=text]]:mr-0";

const renderTile = (id: TileId) => {
    switch (id) {
        case "g-cpu":
        case "g-mem":
        case "g-dsk":
        case "g-swp":
            return <GaugeTile key={id} id={id} />;
        case "h-cpu":
        case "h-mem":
        case "h-net":
        case "hp-net":
            return <HistoryTile key={id} id={id} />;
        case "i-sys":
            return <SystemInfoTile key={id} />;
        case "i-panel":
            return <PanelInfoTile key={id} />;
    }
};

// The page the panel opens on: the mark, the few things the panel can be asked
// for, and then whatever readings this operator wants watching.
//
// Nothing here is a page of its own, because none of it is worked in -- a log is
// read until the question is answered and a backup is taken and saved. They are
// dialogs over the overview for that reason, and the tiles behind them carry on
// polling while one is open.
export const Overview = () => {
    const tiles = useTilesStore((state) => state.tiles);
    const { data: service } = useMaintenance();

    const [openDialog, setOpenDialog] = useState<DialogName | null>(null);

    const tilesButton = useRef<HTMLButtonElement>(null);
    const backupButton = useRef<HTMLButtonElement>(null);
    const logsButton = useRef<HTMLButtonElement>(null);
    const countsButton = useRef<HTMLButtonElement>(null);

    const close = () => setOpenDialog(null);

    // A panel in maintenance shows the tile that can take it out of it, picked
    // or not: the app bar says maintenance is on from every page and leads here,
    // and an overview with that tile switched off would have nothing to say
    // about it and no way to end it.
    const shown =
        service?.maintenance && !tiles.includes("i-panel")
            ? (["i-panel", ...tiles] as TileId[])
            : tiles;

    return (
        <div className="mx-auto w-full p-4 min-[840px]:max-w-[700px] min-[1145px]:max-w-[1000px] min-[1545px]:max-w-[1400px] min-[2138px]:max-w-[2000px]">
            <div className="flex flex-col gap-2 text-center">
                <div className="flex justify-center">
                    {/* The name beside it in the rail says the same thing, so the
                        mark is not read out here as well. It stands smaller once
                        there are tiles under it to be read first. */}
                    <Avatar aria-hidden size={shown.length > 0 ? 100 : 200}>
                        <Avatar.Fallback name={settings.app_title} />
                    </Avatar>
                </div>

                <div>
                    <Button
                        ref={tilesButton}
                        type="button"
                        trailingVisual={<StarAddRegular size={18} />}
                        className={BUTTON_CLASS}
                        onClick={() => setOpenDialog("tiles")}
                    >
                        Tiles
                    </Button>

                    <Button
                        ref={backupButton}
                        type="button"
                        trailingVisual={<HistoryRegular size={18} />}
                        className={`${BUTTON_CLASS} ms-[10px]`}
                        onClick={() => setOpenDialog("backup")}
                    >
                        Backup &amp; restore
                    </Button>

                    <Button
                        ref={logsButton}
                        type="button"
                        trailingVisual={<DocumentBulletListRegular size={18} />}
                        className={`${BUTTON_CLASS} ms-[10px]`}
                        onClick={() => setOpenDialog("logs")}
                    >
                        Logs
                    </Button>

                    <Button
                        ref={countsButton}
                        type="button"
                        trailingVisual={<DataBarVerticalRegular size={18} />}
                        className={`${BUTTON_CLASS} ms-[10px]`}
                        onClick={() => setOpenDialog("counts")}
                    >
                        Counts
                    </Button>
                </div>

                {/* Four across on a wide screen, two on a tablet and one on a
                    phone, so a tile is never narrower than the figure in it. */}
                <div className="grid grid-cols-1 gap-2 min-[600px]:grid-cols-2 min-[840px]:grid-cols-4">
                    {shown.map(renderTile)}
                </div>
            </div>

            {openDialog === "tiles" && <TilesDialog onClose={close} returnFocusRef={tilesButton} />}
            {openDialog === "backup" && (
                <BackupDialog onClose={close} returnFocusRef={backupButton} />
            )}
            {openDialog === "logs" && <LogsDialog onClose={close} returnFocusRef={logsButton} />}
            {openDialog === "counts" && (
                <CountsDialog onClose={close} returnFocusRef={countsButton} />
            )}
        </div>
    );
};
