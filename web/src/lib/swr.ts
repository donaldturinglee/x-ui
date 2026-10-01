import type { SWRConfiguration } from "swr";

// What every read in the panel is fetched under.
//
// A panel is left open on a wall for days, so refreshing on focus and on a
// reconnect is what keeps it from showing yesterday's figures to somebody who
// just walked up to it. Retrying is left on for the same reason: the API going
// away for a moment should heal itself rather than need a reload.
export const swrConfig: SWRConfiguration = {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    // Two components asking for the same thing in the same breath is one
    // request, which is what makes it safe for a table and a summary to read
    // the same key.
    dedupingInterval: 2_000,
    errorRetryInterval: 5_000,
    // Past this it is not a blip. Retrying for ever would keep a panel that
    // cannot reach its API busy rather than letting it say so.
    errorRetryCount: 3,
};
