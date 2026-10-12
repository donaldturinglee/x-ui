import { describe, expect, it } from "vitest";

import type { Outbound } from "@/features/outbounds/api";
import type { OutboundCheckState } from "@/features/outbounds/api/useOutboundChecks";
import { sortOutbounds } from "@/features/outbounds/components/sorting";

const routes: Outbound[] = [
    { id: 1, tag: "proxy-10", type: "socks" },
    { id: 2, tag: "proxy-2", type: "vless" },
    { id: 3, tag: "direct", type: "direct" },
    { id: 4, tag: "blocked", type: "block" },
    { id: 5, tag: "failed", type: "socks" },
    { id: 6, tag: "pending", type: "socks" },
    { id: 7, tag: "unmeasured", type: "socks" },
];

describe("outbound display order", () => {
    it("orders names naturally without changing the configuration order", () => {
        const original = routes.map((route) => route.id);
        const ordered = sortOutbounds(routes, { key: "tag", direction: "ascending" }, {});
        expect(ordered.map((route) => route.tag)).toEqual([
            "blocked",
            "direct",
            "failed",
            "pending",
            "proxy-2",
            "proxy-10",
            "unmeasured",
        ]);
        expect(routes.map((route) => route.id)).toEqual(original);
        expect(sortOutbounds(routes, null, {})).toEqual(routes);
    });

    it.each(["ascending", "descending"] as const)(
        "compares delays numerically and keeps unavailable results last when %s",
        (direction) => {
            const checks: Record<number, OutboundCheckState> = {
                1: { loading: false, result: { ok: true, delay: 120, error: "" } },
                2: { loading: false, result: { ok: true, delay: 8, error: "" } },
                3: { loading: false, result: { ok: true, delay: 0, error: "" } },
                4: { loading: false, result: { ok: true, delay: 1, error: "" } },
                5: { loading: false, result: { ok: false, delay: 0, error: "Timed out" } },
                6: { loading: true, result: { ok: true, delay: 2, error: "" } },
            };
            const ordered = sortOutbounds(routes, { key: "delay", direction }, checks);
            expect(ordered.map((route) => route.id)).toEqual([
                ...(direction === "ascending" ? [3, 2, 1] : [1, 2, 3]),
                4,
                5,
                6,
                7,
            ]);
            expect(routes.map((route) => route.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        },
    );

    it("keeps equal measurements in their original order", () => {
        const checks: Record<number, OutboundCheckState> = {
            1: { loading: false, result: { ok: true, delay: 12, error: "" } },
            2: { loading: false, result: { ok: true, delay: 12, error: "" } },
        };
        expect(
            sortOutbounds(routes, { key: "delay", direction: "descending" }, checks).map(
                (route) => route.id,
            ),
        ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
});
