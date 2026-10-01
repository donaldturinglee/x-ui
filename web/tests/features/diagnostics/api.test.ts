import { describe, expect, it } from "vitest";

import { logsQuery, statsQuery, toPoints, totalOf, type Series } from "@/features/diagnostics/api";

const buildSeries = (overrides: Partial<Series> = {}): Series => ({
    stats: {},
    startTime: 1_700_000_000,
    bucketSpan: 3_600,
    numBuckets: 4,
    ...overrides,
});

describe("statsQuery", () => {
    it("asks for one resource and tag at a time", () => {
        expect(statsQuery("client", "alice", 24)).toBe("/stats?resource=client&tag=alice&hours=24");
    });

    it("escapes a tag that would otherwise change the query", () => {
        expect(statsQuery("inbound", "edge&x=1", 24)).toContain("tag=edge%26x%3D1");
    });
});

describe("logsQuery", () => {
    it("asks for a level and a count", () => {
        expect(logsQuery("warning", 50)).toBe("/logs?level=warning&count=50");
    });
});

describe("toPoints", () => {
    it("fills in the buckets the series left out", () => {
        // A quiet hour has no row. Drawing only the buckets that carried traffic
        // would put an hour of silence and an hour of use side by side as
        // though they were adjacent.
        const points = toPoints(buildSeries({ stats: { "0": [10, 20], "3": [1, 2] } }));

        expect(points).toHaveLength(4);
        expect(points[1]).toEqual({ at: (1_700_000_000 + 3_600) * 1000, up: 0, down: 0 });
        expect(points[3]).toEqual({ at: (1_700_000_000 + 3 * 3_600) * 1000, up: 1, down: 2 });
    });

    it("counts in milliseconds, which is what a chart reads", () => {
        expect(toPoints(buildSeries({ numBuckets: 1 }))[0].at).toBe(1_700_000_000_000);
    });
});

describe("totalOf", () => {
    it("adds both directions, which is what was moved", () => {
        expect(totalOf(toPoints(buildSeries({ stats: { "0": [10, 20], "1": [1, 2] } })))).toBe(33);
    });

    it("is nothing when nothing was counted", () => {
        expect(totalOf(toPoints(buildSeries()))).toBe(0);
    });
});
