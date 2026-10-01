import { useSyncExternalStore } from "react";

// The wall clock, read the way anything outside React has to be: a snapshot
// taken on render rather than a call made during one, so that a figure worked
// out from the time of day is redrawn when the answer changes instead of
// whenever the component happens to render.
//
// Half a minute is as often as anything here needs it. What is read from it is
// how long a host or a process has been up, which is written in hours and days.
const TICK_MS = 30_000;

const subscribe = (onChange: () => void) => {
    const timer = setInterval(onChange, TICK_MS);

    return () => clearInterval(timer);
};

// Held to the tick rather than to the millisecond, because React compares one
// snapshot with the last and a clock that never gives the same answer twice
// would have it redrawing for ever.
const snapshot = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

export const useNow = () => useSyncExternalStore(subscribe, snapshot, snapshot);
