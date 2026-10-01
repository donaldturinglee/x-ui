import { Badge, Text, Tooltip } from "@gamecrafters/base-ui/react";
import { ArrowSyncRegular } from "@gamecrafters/base-ui-icons";

import { useNow } from "@/lib/clock";

import { formatUptime, useSystemStatus } from "../api";
import { tileTitle } from "../tiles";

import { Tile, TileAction } from "./Tile";

const startedAt = (bootTime: number) => new Date(bootTime * 1000).toLocaleString();

// What the panel is running on. None of it moves while the host is up, which is
// why the tile carries a way to ask again: the figures beside it are polled, and
// an operator who has just resized a disk or added a core should not have to
// wait for a reading that never changes on its own.
export const SystemInfoTile = () => {
    const { data: status, mutate, isValidating } = useSystemStatus();
    const now = useNow();

    const host = status?.host;
    // The API sends when the host booted rather than how long it has been up: a
    // figure that was true when the response was written is already stale by the
    // time it is read, and this one is worked out afresh as the clock moves.
    const uptime = host ? formatUptime(now / 1000 - host.bootTime) : "—";

    return (
        <Tile
            title={tileTitle("i-sys")}
            action={
                <TileAction
                    icon={ArrowSyncRegular}
                    label="Read the host again"
                    description="Read the host again"
                    loading={isValidating}
                    onClick={() => void mutate()}
                />
            }
        >
            <div className="grid grid-cols-12 items-center gap-2">
                <div className="col-span-3">Host</div>
                <div className="col-span-9 truncate">{host?.hostname ?? "—"}</div>

                <div className="col-span-3">CPU</div>
                <div className="col-span-9">
                    {host ? (
                        // The model is the part an operator compares against a
                        // price list, and is far too long to stand in a tile.
                        <Tooltip text={host.cpuModel ?? "The host did not say which processor"}>
                            <Badge as="button" type="button">
                                {host.cpus} {host.cpus === 1 ? "core" : "cores"}
                            </Badge>
                        </Tooltip>
                    ) : (
                        "—"
                    )}
                </div>

                <div className="col-span-3">Platform</div>
                <div className="col-span-9">
                    {host ? <Badge variant="accent">{host.platform}</Badge> : "—"}
                </div>

                <div className="col-span-3">Panel</div>
                <div className="col-span-9">
                    {status ? <Badge variant="accent">v{status.app.version}</Badge> : "—"}
                </div>

                <div className="col-span-3">Uptime</div>
                <div className="col-span-9">
                    {host ? (
                        <Tooltip text={`Started ${startedAt(host.bootTime)}`}>
                            <Badge as="button" type="button" variant="invisible">
                                {uptime}
                            </Badge>
                        </Tooltip>
                    ) : (
                        <Text>—</Text>
                    )}
                </div>
            </div>
        </Tile>
    );
};
