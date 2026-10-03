import { Avatar, Button, InlineMessage } from "@gamecrafters/base-ui/react";
import {
    DataBarVerticalRegular,
    DocumentBulletListRegular,
    HistoryRegular,
    StarAddRegular,
} from "@gamecrafters/base-ui-icons";
import { useEffect, useRef, useState } from "react";

import { settings } from "@/settings";
import { useTilesStore } from "@/stores/tiles";

import { useMaintenance } from "./api";
import { isCoreRestartActive, useCoreStatus } from "./api/core";
import {
    isUpgradeActive,
    upgradeMessage,
    useUpgradeJob,
    useUpgradeStatus,
    useUpgradeTracking,
} from "./api/upgrade";
import { CoreInfoTile } from "./components/CoreInfoTile";
import { BackupDialog } from "./components/BackupDialog";
import { CountsDialog } from "./components/CountsDialog";
import { GaugeTile } from "./components/GaugeTile";
import { HistoryTile } from "./components/HistoryTile";
import { LogsDialog } from "./components/LogsDialog";
import { PanelInfoTile } from "./components/PanelInfoTile";
import { SystemInfoTile } from "./components/SystemInfoTile";
import { TilesDialog } from "./components/TilesDialog";
import { PanelUpgradeDialog } from "./components/PanelUpgradeDialog";
import { type TileId } from "./tiles";

type DialogName = "tiles" | "backup" | "logs" | "counts" | "upgrade";

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
        case "i-core":
            return <CoreInfoTile key={id} />;
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
    const { data: core } = useCoreStatus();
    const { data: upgrade } = useUpgradeStatus();
    const trackedUpgrade = useUpgradeTracking((state) => state.id);
    const trackUpgrade = useUpgradeTracking((state) => state.track);
    const { data: upgradeTask, error: upgradeTaskError } = useUpgradeJob(
        upgrade?.job?.id ?? trackedUpgrade,
    );
    const upgradeJob = upgradeTask ?? upgrade?.job;

    useEffect(() => {
        if (upgradeJob && isUpgradeActive(upgradeJob) && trackedUpgrade !== upgradeJob.id)
            trackUpgrade(upgradeJob.id);
        if (
            upgradeJob?.state !== "succeeded" ||
            trackedUpgrade !== upgradeJob.id ||
            upgrade?.currentVersion !== upgradeJob.toVersion
        )
            return;
        // Reload once after confirmation, so the running panel uses the new bundle.
        const key = `x-ui-upgrade-reloaded:${upgradeJob.id}`;
        try {
            if (sessionStorage.getItem(key)) return;
            sessionStorage.setItem(key, "1");
        } catch {
            return;
        }
        window.location.reload();
    }, [upgradeJob, upgrade?.currentVersion, trackedUpgrade, trackUpgrade]);

    const [openDialog, setOpenDialog] = useState<DialogName | null>(null);

    const tilesButton = useRef<HTMLButtonElement>(null);
    const backupButton = useRef<HTMLButtonElement>(null);
    const logsButton = useRef<HTMLButtonElement>(null);
    const countsButton = useRef<HTMLButtonElement>(null);
    const upgradeButton = useRef<HTMLButtonElement>(null);

    const close = () => setOpenDialog(null);

    // A panel in maintenance shows the tile that can take it out of it, picked
    // or not: the app bar says maintenance is on from every page and leads here,
    // and an overview with that tile switched off would have nothing to say
    // about it and no way to end it.
    const maintenanceTiles =
        service?.maintenance && !tiles.includes("i-panel")
            ? (["i-panel", ...tiles] as TileId[])
            : tiles;
    const shown =
        isCoreRestartActive(core?.restartJob) && !maintenanceTiles.includes("i-core")
            ? ([...maintenanceTiles, "i-core"] as TileId[])
            : maintenanceTiles;

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

                <div className="flex flex-wrap justify-center gap-2">
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
                        className={BUTTON_CLASS}
                        onClick={() => setOpenDialog("backup")}
                    >
                        Backup &amp; restore
                    </Button>

                    <Button
                        ref={logsButton}
                        type="button"
                        trailingVisual={<DocumentBulletListRegular size={18} />}
                        className={BUTTON_CLASS}
                        onClick={() => setOpenDialog("logs")}
                    >
                        Logs
                    </Button>

                    <Button
                        ref={countsButton}
                        type="button"
                        trailingVisual={<DataBarVerticalRegular size={18} />}
                        className={BUTTON_CLASS}
                        onClick={() => setOpenDialog("counts")}
                    >
                        Counts
                    </Button>
                    <Button
                        ref={upgradeButton}
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => setOpenDialog("upgrade")}
                    >
                        Upgrade
                    </Button>
                </div>

                {(isUpgradeActive(upgradeJob) ||
                    upgradeJob?.needsRecovery ||
                    (trackedUpgrade && upgradeTaskError)) && (
                    <InlineMessage variant={upgradeJob?.needsRecovery ? "critical" : "warning"}>
                        <div role="status">
                            {upgradeTaskError
                                ? "Waiting for the panel to reconnect. The upgrade result has not yet been confirmed."
                                : upgradeMessage(upgradeJob)}
                        </div>
                        <Button type="button" onClick={() => setOpenDialog("upgrade")}>
                            View upgrade
                        </Button>
                    </InlineMessage>
                )}

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
            {openDialog === "upgrade" && (
                <PanelUpgradeDialog onClose={close} returnFocusRef={upgradeButton} />
            )}
        </div>
    );
};
