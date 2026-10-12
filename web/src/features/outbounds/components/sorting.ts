import { refusesAll, type Outbound } from "../api";
import type { OutboundCheckState } from "../api/useOutboundChecks";

export type OutboundSortKey = "tag" | "type" | "delay";

export interface OutboundSort {
    key: OutboundSortKey;
    direction: "ascending" | "descending";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const delayOf = (outbound: Outbound, checks: Record<number, OutboundCheckState>) => {
    const check = checks[outbound.id];
    return !refusesAll(outbound.type) &&
        !check?.loading &&
        check?.result?.ok &&
        Number.isFinite(check.result.delay) &&
        check.result.delay >= 0
        ? check.result.delay
        : null;
};

// Ordering is local to the page. Missing or failed measurements stay after
// successful ones in either direction, and ties keep the API's original order.
export const sortOutbounds = (
    outbounds: Outbound[],
    sort: OutboundSort | null,
    checks: Record<number, OutboundCheckState>,
): Outbound[] => {
    if (!sort) return outbounds;

    const sign = sort.direction === "ascending" ? 1 : -1;
    return [...outbounds].sort((left, right) => {
        if (sort.key !== "delay") {
            return sign * collator.compare(left[sort.key], right[sort.key]);
        }

        const leftDelay = delayOf(left, checks);
        const rightDelay = delayOf(right, checks);
        if (leftDelay === null) return rightDelay === null ? 0 : 1;
        if (rightDelay === null) return -1;
        return sign * (leftDelay - rightDelay);
    });
};

export const nextOutboundSort = (
    sort: OutboundSort | null,
    key: OutboundSortKey,
): OutboundSort | null =>
    sort?.key !== key
        ? { key, direction: "ascending" }
        : sort.direction === "ascending"
          ? { key, direction: "descending" }
          : null;
