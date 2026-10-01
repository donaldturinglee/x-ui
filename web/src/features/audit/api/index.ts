import useSWR from "swr";

import { request } from "@/lib/request";

// One entry in the audit log: who changed what, when, and to what.
//
// It answers the question an operator asks after the fact — why is this
// subscriber disabled — which neither the record itself nor the process log can,
// because the record holds only its current state and the log is rotated away.
export interface Change {
    id: number;
    dateTime: number;
    // An operator's username, or the name of the job that made the change.
    actor: string;
    // The kind of object that changed, e.g. "clients".
    key: string;
    // What happened to it, e.g. "new", "edit", "del", "disable".
    action: string;
    obj: unknown;
}

export const CHANGES_KEY = "/changes";

// The API narrows the log to one actor itself, so asking for one operator's
// changes reads those rather than the latest of everybody's with theirs
// picked out.
export const changesQuery = (actor?: string) =>
    actor ? `${CHANGES_KEY}?actor=${encodeURIComponent(actor)}` : CHANGES_KEY;

export const getChanges = async (key: string) => {
    return request.get<Change[]>(key);
};

export const useChanges = (actor?: string) => {
    return useSWR<Change[], Error>(changesQuery(actor), getChanges);
};

// The jobs that make changes without anyone asking. Telling them apart from an
// operator is the difference between "somebody did this" and "the quota ran
// out", which is usually the question being asked of this log.
const JOB_ACTORS = new Set(["DepleteJob", "ResetJob", "System"]);

export const isAutomated = (change: Change) => JOB_ACTORS.has(change.actor);

// What a change was made to, rendered for a table. The API stores just enough to
// identify the object rather than its contents, so this is short by design.
export const describeSubject = (change: Change) => {
    const subject = change.obj;

    if (typeof subject === "string") {
        return subject;
    }

    if (subject && typeof subject === "object") {
        const record = subject as Record<string, unknown>;
        const label = record.name ?? record.tag ?? record.username;

        if (typeof label === "string") {
            return label;
        }

        if (Array.isArray(subject)) {
            return subject.join(", ");
        }

        if (typeof record.id === "number") {
            return `#${record.id}`;
        }
    }

    return "—";
};
