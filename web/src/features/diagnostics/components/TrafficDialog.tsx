import {
    Chart,
    Dialog,
    InlineMessage,
    SkeletonBox,
    Stack,
    Text,
    useChart,
} from "@gamecrafters/base-ui/react";
import type { RefObject } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { formatBytes } from "@/features/overview/api";

import { toPoints, totalOf, useStats, type StatsResource, type TrafficPoint } from "../api";

interface TrafficDialogProps {
    resource: StatsResource;
    tag: string;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// What was actually measured, rather than the running total on the row. A quota
// says how much is left; this says when it went, which is the question asked
// when a subscriber says their connection stopped working on Tuesday.
export const TrafficDialog = ({ resource, tag, onClose, returnFocusRef }: TrafficDialogProps) => {
    const { data: series, error, isLoading } = useStats(resource, tag);

    const points = series ? toPoints(series) : [];

    const chart = useChart<TrafficPoint>({
        data: points,
        series: [
            { name: "down", label: "Down" },
            { name: "up", label: "Up" },
        ],
    });

    return (
        <Dialog
            title="Traffic"
            subtitle={tag}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
            footerButtons={[{ content: "Close", onClick: onClose }]}
        >
            <Stack gap="normal">
                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                {isLoading && <SkeletonBox height="240px" />}

                {series && (
                    <>
                        <Text>
                            {formatBytes(totalOf(points))} over the last{" "}
                            {Math.round((series.bucketSpan * series.numBuckets) / 3600)} hours.
                        </Text>

                        {/* Stacked, because what an operator reads off this is
                            how much moved rather than which direction it went in
                            -- the split is there when they look closer. */}
                        <Chart chart={chart}>
                            <AreaChart data={points} height={240}>
                                <CartesianGrid vertical={false} />
                                <XAxis
                                    dataKey="at"
                                    tickFormatter={(at: number) =>
                                        new Date(at).toLocaleTimeString(undefined, {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })
                                    }
                                    minTickGap={48}
                                />
                                <YAxis
                                    tickFormatter={(bytes: number) => formatBytes(bytes)}
                                    width={72}
                                />
                                <Chart.Tooltip />
                                <Area
                                    dataKey="down"
                                    stackId="traffic"
                                    stroke={chart.color("down")}
                                    fill={chart.color("down")}
                                />
                                <Area
                                    dataKey="up"
                                    stackId="traffic"
                                    stroke={chart.color("up")}
                                    fill={chart.color("up")}
                                />
                            </AreaChart>
                        </Chart>

                        {/* The split as figures rather than a legend: which
                            colour is which matters less than how much went each
                            way, and the tooltip names them on hover. */}
                        <Text className="opacity-70">
                            ↓{" "}
                            {formatBytes(
                                points.reduce((carried, point) => carried + point.down, 0),
                            )}{" "}
                            down · ↑{" "}
                            {formatBytes(points.reduce((carried, point) => carried + point.up, 0))}{" "}
                            up
                        </Text>

                        {totalOf(points) === 0 && (
                            <Text className="opacity-70">
                                Nothing was counted in this window. Traffic is reported by the node
                                agent, so a node that is not running reports none.
                            </Text>
                        )}
                    </>
                )}
            </Stack>
        </Dialog>
    );
};
