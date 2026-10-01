import type { CoreConfig } from "@/features/config/api";

// What a node's core logs -- whether it logs at all, how much, where to and
// whether each line is stamped with the time -- which is the base document's
// `log` key. Like the core's experimental interfaces, the key is edited as a
// copy on its tab and the document written back whole, with only the key
// changed.
//
// Only what the tab shows has a name here. Anything else the core accepts under
// the key is carried through an edit untouched.
export type Log = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// The key as the document holds it, read as an object whatever the document
// says, so the tab has something to build on.
export const logOf = (config: CoreConfig | undefined): Log =>
    isPlainObject(config?.log) ? config.log : {};

// An option cleared on the tab is left out rather than written as an empty
// value, which the core would read as one that was set.
const cleaned = (log: Log): Log =>
    Object.fromEntries(
        Object.entries(log).filter(([, option]) => option !== undefined && option !== ""),
    );

// The document with the key replaced and everything else as it was read.
export const withLog = (config: CoreConfig, log: Log): CoreConfig => ({
    ...config,
    log: cleaned(log),
});

// Whether what is on the tab differs from what the document holds.
export const isLogChanged = (config: CoreConfig | undefined, log: Log) =>
    JSON.stringify(logOf(config)) !== JSON.stringify(logOf(withLog(config ?? {}, log)));

// Where the proxy core documents the key, for the link beside the tab's text.
export const LOG_DOCS = "https://sing-box.sagernet.org/configuration/log/";

// How much the core says, from the most to the least.
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "panic"];
