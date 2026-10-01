import { Badge, IconButton, Tooltip, type BadgeVariant } from "@gamecrafters/base-ui/react";
import { WrenchRegular } from "@gamecrafters/base-ui-icons";
import { useState } from "react";

import { formatBytes, formatUptime, useMaintenance, useOnlines, useSystemStatus } from "../api";
import { tileTitle } from "../tiles";

import { MaintenanceDialog } from "./MaintenanceDialog";
import { Tile } from "./Tile";

// What has moved traffic in the last few minutes, by what moved it. It is
// derived from reported traffic rather than from a connection the panel holds,
// so a node that died without saying so drops off on its own.
const ONLINE_GROUPS: {
    title: string;
    key: "client" | "inbound" | "outbound";
    variant: BadgeVariant;
}[] = [
    { title: "Subscribers", key: "client", variant: "accent" },
    { title: "Listeners", key: "inbound", variant: "success" },
    { title: "Routes out", key: "outbound", variant: "done" },
];

// What the panel process itself is doing, and the one control that changes it,
// which is asked about before it is done.
export const PanelInfoTile = () => {
    const { data: status } = useSystemStatus();
    const { data: onlines } = useOnlines();
    const { data: service } = useMaintenance();

    const [isConfirming, setIsConfirming] = useState(false);

    const maintenance = service?.maintenance ?? status?.app.maintenance ?? false;

    return (
        <Tile title={tileTitle("i-panel")}>
            <div className="grid grid-cols-12 items-center gap-2">
                <div className="col-span-4">Service</div>
                <div className="col-span-8 flex items-center justify-center gap-1">
                    <Badge variant={maintenance ? "attention" : "success"}>
                        {maintenance ? "Maintenance" : "Serving"}
                    </Badge>

                    <Tooltip
                        text={
                            maintenance
                                ? "Put the listeners back into the configuration nodes fetch"
                                : "Withhold every listener from the configuration nodes fetch"
                        }
                    >
                        <IconButton
                            icon={<WrenchRegular size={18} />}
                            aria-label={
                                maintenance ? "Turn maintenance off" : "Turn maintenance on"
                            }
                            variant="invisible"
                            className="size-6 rounded-full text-[var(--foreground-color-attention)]"
                            onClick={() => setIsConfirming(true)}
                        />
                    </Tooltip>
                </div>

                <div className="col-span-4">Memory</div>
                <div className="col-span-8">
                    {status ? (
                        <Badge variant="accent">{formatBytes(status.app.heapBytes)}</Badge>
                    ) : (
                        "—"
                    )}
                </div>

                <div className="col-span-4">Threads</div>
                <div className="col-span-8">
                    {status ? <Badge variant="accent">{status.app.goroutines}</Badge> : "—"}
                </div>

                <div className="col-span-4">Uptime</div>
                <div className="col-span-8">
                    {status ? formatUptime(status.app.uptimeSeconds) : "—"}
                </div>

                <div className="col-span-4">Online</div>
                <div className="col-span-8 flex items-center justify-center gap-1">
                    {ONLINE_GROUPS.map(({ title, key, variant }) => {
                        const tags = onlines?.[key] ?? [];

                        return (
                            // The count is what fits; which listener or which
                            // subscriber it was is what the tooltip is for.
                            <Tooltip
                                key={key}
                                text={
                                    tags.length
                                        ? `${title}: ${tags.join(", ")}`
                                        : `No ${title.toLowerCase()}`
                                }
                            >
                                <Badge as="button" type="button" variant={variant}>
                                    {tags.length}
                                </Badge>
                            </Tooltip>
                        );
                    })}
                </div>
            </div>

            {isConfirming && (
                <MaintenanceDialog
                    maintenance={maintenance}
                    onClose={() => setIsConfirming(false)}
                />
            )}
        </Tile>
    );
};
