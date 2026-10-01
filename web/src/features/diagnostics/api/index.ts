import useSWR from "swr";

import { request } from "@/lib/request";

// What the API already answers and the panel never asked for: the traffic it has
// been counting, the log it has been keeping, and what the host it runs on is
// doing.

// A downsampled traffic series. Buckets are indexed rather than listed, because
// a quiet hour has no row: the index says where it sits, and everything between
// two indices was nothing.
export interface Series {
    stats: Record<string, [number, number]>;
    startTime: number;
    bucketSpan: number;
    numBuckets: number;
}

export type StatsResource = "inbound" | "outbound" | "client";

export const STATS_KEY = "/stats";
export const LOGS_KEY = "/logs";

// How far back a chart looks by default. A day is what an operator is usually
// asking about -- whether something is running now, and whether it was running
// this morning.
export const DEFAULT_STATS_HOURS = 24;

export const statsQuery = (resource: StatsResource, tag: string, hours: number) =>
    `${STATS_KEY}?resource=${resource}&tag=${encodeURIComponent(tag)}&hours=${hours}`;

// Null while nothing is being asked about, so a dialog that is not open fetches
// nothing.
export const useStats = (
    resource: StatsResource,
    tag: string | null,
    hours = DEFAULT_STATS_HOURS,
) => {
    return useSWR<Series, Error>(
        tag === null ? null : statsQuery(resource, tag, hours),
        (key: string) => request.get<Series>(key),
    );
};

// One point per bucket, including the buckets the series left out. A chart drawn
// only from the buckets that carried traffic would put an hour of silence and an
// hour of use side by side as though they were adjacent.
export interface TrafficPoint {
    at: number;
    up: number;
    down: number;
}

export const toPoints = (series: Series): TrafficPoint[] => {
    const points: TrafficPoint[] = [];

    for (let bucket = 0; bucket < series.numBuckets; bucket++) {
        const [up, down] = series.stats[String(bucket)] ?? [0, 0];

        points.push({
            at: (series.startTime + bucket * series.bucketSpan) * 1000,
            up,
            down,
        });
    }

    return points;
};

export const totalOf = (points: TrafficPoint[]) =>
    points.reduce((carried, point) => carried + point.up + point.down, 0);

export type LogLevel = "debug" | "info" | "warning" | "error";

export const logsQuery = (level: LogLevel, count: number) =>
    `${LOGS_KEY}?level=${level}&count=${count}`;

// Read from an in-memory ring, so it is this process only and does not survive a
// restart. Worth saying where it is shown: an empty log after a restart is not a
// quiet panel.
export const useLogs = (level: LogLevel, count = 200) => {
    return useSWR<string[], Error>(logsQuery(level, count), (key: string) =>
        request.get<string[]>(key),
    );
};
