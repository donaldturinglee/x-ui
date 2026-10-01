import useSWR, { useSWRConfig } from "swr";

import { MAINTENANCE_KEY, ONLINES_KEY, type Onlines } from "@/features/overview/api";

import { request } from "./request";

// The panel is left open while work happens elsewhere: a subscriber runs out of
// quota and the worker disables them, an operator on another screen adds a
// listener. Without this the table keeps showing what it read when the page was
// opened, and the first anyone knows is a reload.
export const LOAD_KEY = "/load";

// Often enough that a table is never far behind, seldom enough that a panel left
// open all day is not a load of its own. The poll is cheap by design: when
// nothing has changed the API answers with the cursor and little else.
const POLL_INTERVAL_MS = 10_000;

// What the API sends back. Only `lu`, `onlines` and `maintenance` are there when
// nothing has moved -- everything else is present exactly when `changed` is.
interface Snapshot {
    lu: number;
    changed?: boolean;
    maintenance?: boolean;
    onlines?: Onlines;
}

// The cursor the next poll asks from, held outside React because it belongs to
// the session rather than to whichever page happens to be mounted. A failed
// poll drops it: the likeliest reason is a session that has gone, and coming
// back with a stale cursor would have the API report no changes against a cache
// that was cleared underneath it.
let cursor = 0;

const fetchSnapshot = async () => {
    try {
        const snapshot = await request.get<Snapshot>(
            cursor > 0 ? `${LOAD_KEY}?lu=${cursor}` : LOAD_KEY,
        );

        cursor = snapshot.lu;

        return snapshot;
    } catch (error) {
        cursor = 0;

        throw error;
    }
};

// useLive keeps what is on screen current. It is mounted once, by the shell
// every signed-in page is built from, so there is one poll however many tables
// are reading from it.
//
// It does not replace what each feature reads. A change is a signal to ask
// again, not a payload to render from: the tables stay the authority on their
// own shape, and a listing that is filtered or paged is refetched as it was
// rather than replaced by the snapshot's own idea of the first page.
export const useLive = () => {
    const { mutate } = useSWRConfig();

    useSWR<Snapshot, Error>(LOAD_KEY, fetchSnapshot, {
        refreshInterval: POLL_INTERVAL_MS,
        // The poll is the thing that keeps everything else fresh, so it is the
        // one read that should not also be revalidated by the others.
        revalidateOnFocus: false,
        onSuccess: (snapshot) => {
            // Carried on every poll whether anything changed or not, so it is
            // written straight into the cache rather than waiting for a change
            // to justify a refetch.
            if (snapshot.onlines) {
                void mutate(ONLINES_KEY, snapshot.onlines, false);
            }

            if (snapshot.maintenance !== undefined) {
                void mutate(MAINTENANCE_KEY, { maintenance: snapshot.maintenance }, false);
            }

            if (!snapshot.changed) {
                return;
            }

            // Everything except this poll. Enumerating the keys instead would
            // mean a feature added later is silently left stale, which is the
            // failure this exists to prevent.
            void mutate((key) => typeof key === "string" && !key.startsWith(LOAD_KEY));
        },
    });
};
