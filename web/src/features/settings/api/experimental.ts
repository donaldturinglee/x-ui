import type { CoreConfig } from "@/features/config/api";

// The interfaces a node's core serves beside the proxy -- the cache it keeps
// between restarts, the Clash API and the V2Ray API -- which are the base
// document's `experimental` key. Like NTP, HTTP clients, DNS and rules, the key
// is edited as a copy on its tab and the document written back whole, with only
// the key changed.
//
// Only what the tab shows has a name here. Anything else the core accepts under
// the key is carried through an edit untouched.
export type Experimental = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// The key as the document holds it, read as an object whatever the document
// says, so the tab has something to build on.
export const experimentalOf = (config: CoreConfig | undefined): Experimental =>
    isPlainObject(config?.experimental) ? config.experimental : {};

// An option cleared on the tab is left out rather than written as an empty
// value, which the core would read as one that was set -- at any depth, since
// each interface holds an object of its own.
const cleaned = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(value)
            .filter(([, option]) => option !== undefined && option !== "")
            .map(([key, option]) => [key, isPlainObject(option) ? cleaned(option) : option]),
    );

// The document with the key replaced and everything else as it was read.
export const withExperimental = (config: CoreConfig, experimental: Experimental): CoreConfig => ({
    ...config,
    experimental: cleaned(experimental),
});

// Whether what is on the tab differs from what the document holds.
export const isExperimentalChanged = (config: CoreConfig | undefined, experimental: Experimental) =>
    JSON.stringify(experimentalOf(config)) !==
    JSON.stringify(experimentalOf(withExperimental(config ?? {}, experimental)));

// Where the proxy core documents each interface, for the link beside a group's
// heading.
const DOCS = "https://sing-box.sagernet.org/configuration/experimental";

export const EXPERIMENTAL_DOCS = {
    experimental: `${DOCS}/`,
    cacheFile: `${DOCS}/cache-file/`,
    clashApi: `${DOCS}/clash-api/`,
    v2rayApi: `${DOCS}/v2ray-api/`,
};

// A list written as the reference asks for it: comma separated, space ignored.
export const toList = (text: string) =>
    text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

export const fromList = (list: unknown) =>
    Array.isArray(list) ? list.filter((item) => typeof item === "string").join(", ") : "";
