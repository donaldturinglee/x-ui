import { Chart, useChart } from "@gamecrafters/base-ui/react";
import { InfoRegular } from "@gamecrafters/base-ui-icons";
import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { formatBytes, formatPackets, useSystemStatus, type SystemStatus } from "../api";
import { tileTitle, type ChartTileId } from "../tiles";

import { Tile, TileAction } from "./Tile";

// One reading in the window a chart draws: the poll it came from, and a value
// for each series the chart plots.
type Point = Record<string, number>;

interface Shape {
    // What is plotted, in the colours the palette knows by name.
    series: { name: string; label: string; color: string }[];
    // How a value is written on the axis.
    format: (value: number) => string;
    // A percentage is drawn against the whole scale rather than against the
    // highest reading in the window, or a quiet minute would look like a busy
    // one.
    domain?: [number, number];
    // The reading, taken from the status and -- where what is read is a rate --
    // from what the poll before it said. Null is nothing to plot: a figure the
    // host does not report, or a rate with only one end.
    read: (status: SystemStatus, previous?: SystemStatus) => Point | null;
}

// How long the poll interval is does not matter to a rate as long as it is
// measured: the process counts its own seconds, and the difference between two
// readings of that is exactly how long passed between them.
const elapsed = (status: SystemStatus, previous?: SystemStatus) =>
    previous ? status.app.uptimeSeconds - previous.app.uptimeSeconds : 0;

const percent = (value: number) => `${Math.round(value)}`;

const SHAPES: Record<ChartTileId, Shape> = {
    "h-cpu": {
        series: [{ name: "load", label: "Load", color: "orange" }],
        format: percent,
        domain: [0, 100],
        read: (status) => (status.cpuPercent === undefined ? null : { load: status.cpuPercent }),
    },
    "h-mem": {
        series: [{ name: "used", label: "Used", color: "orange" }],
        format: percent,
        domain: [0, 100],
        read: (status) =>
            status.memory?.total
                ? { used: (status.memory.current / status.memory.total) * 100 }
                : null,
    },
    "h-net": {
        series: [
            { name: "out", label: "Out", color: "orange" },
            { name: "in", label: "In", color: "green" },
        ],
        format: (value) => (value === 0 ? "0" : formatBytes(value)),
        read: (status, previous) => {
            const seconds = elapsed(status, previous);

            if (!status.network || !previous?.network || seconds <= 0) {
                return null;
            }

            return {
                out: (status.network.bytesSent - previous.network.bytesSent) / seconds,
                in: (status.network.bytesRecv - previous.network.bytesRecv) / seconds,
            };
        },
    },
    "hp-net": {
        series: [
            { name: "out", label: "Out", color: "orange" },
            { name: "in", label: "In", color: "green" },
        ],
        format: (value) => (value === 0 ? "0" : formatPackets(value)),
        read: (status, previous) => {
            const seconds = elapsed(status, previous);

            if (!status.network || !previous?.network || seconds <= 0) {
                return null;
            }

            return {
                out: (status.network.packetsSent - previous.network.packetsSent) / seconds,
                in: (status.network.packetsRecv - previous.network.packetsRecv) / seconds,
            };
        },
    },
};

// As many readings as the plot has room to tell apart.
const WINDOW = 20;

// The window a chart draws, which is kept here rather than asked for: the API
// answers with what is happening now and has no memory of what was. It starts
// empty on every visit for the same reason, and a chart of rates stays empty
// until a second reading arrives to measure the first against.
//
// A tile is keyed by its id on the page, so a chart swapped for another one is
// mounted afresh and begins a window of its own rather than carrying this one's
// readings over into a figure they are not.
const useHistory = (id: ChartTileId, status: SystemStatus | undefined) => {
    const [points, setPoints] = useState<Point[]>([]);
    const previous = useRef<SystemStatus | undefined>(undefined);

    useEffect(() => {
        if (!status) {
            return;
        }

        const point = SHAPES[id].read(status, previous.current);

        previous.current = status;

        if (!point) {
            return;
        }

        setPoints((carried) => [...carried, point].slice(-WINDOW));
    }, [id, status]);

    return points;
};

// What the totals behind a network chart come to. The chart itself is drawn in
// rates, which says whether anything is moving but not how much has moved since
// the host came up.
const describeTotals = (status: SystemStatus | undefined, id: ChartTileId) => {
    if (!status?.network || (id !== "h-net" && id !== "hp-net")) {
        return null;
    }

    const { bytesRecv, bytesSent, packetsRecv, packetsSent } = status.network;

    return id === "h-net"
        ? `↓ ${formatBytes(bytesRecv)} in · ↑ ${formatBytes(bytesSent)} out`
        : `↓ ${formatPackets(packetsRecv)} in · ↑ ${formatPackets(packetsSent)} out`;
};

// The last few readings of one figure, drawn as a filled line. It is the same
// reading a gauge shows, answering the other question: a dial says how much is
// gone, and this says whether it has been climbing.
export const HistoryTile = ({ id }: { id: ChartTileId }) => {
    const { data: status } = useSystemStatus();
    const shape = SHAPES[id];
    const points = useHistory(id, status);
    const totals = describeTotals(status, id);

    const chart = useChart<Point>({ data: points, series: shape.series });

    return (
        <Tile
            title={tileTitle(id)}
            action={
                totals ? (
                    <TileAction
                        icon={InfoRegular}
                        label="Totals since the host came up"
                        description={totals}
                    />
                ) : undefined
            }
        >
            <Chart chart={chart} className="h-[150px] [--chart-aspect-ratio:auto]">
                <AreaChart data={points}>
                    <CartesianGrid />
                    {/* The points are readings rather than moments, and are only
                        ever read as a shape, so the axis is there to place them
                        rather than to be read. */}
                    <XAxis hide />
                    <YAxis domain={shape.domain} tickFormatter={shape.format} width={56} />

                    {chart.series.map((series) => (
                        <Area
                            key={series.name}
                            dataKey={series.name as string}
                            stroke={chart.color(series.color)}
                            fill={chart.color(series.color)}
                            fillOpacity={0.2}
                            strokeWidth={1}
                            dot={false}
                            // A line that slides along as it is redrawn every
                            // few seconds is harder to read than one that does
                            // not, and is redrawn often enough to be seen doing
                            // it.
                            isAnimationActive={false}
                        />
                    ))}
                </AreaChart>
            </Chart>
        </Tile>
    );
};
