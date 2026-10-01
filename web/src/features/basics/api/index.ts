import { z } from "zod";

import type { CoreConfig } from "@/features/config/api";

// NTP and shared HTTP clients are separate keys of the base document. Each
// settings tab edits its own key and carries everything else through a save.
export type Ntp = Record<string, unknown>;

// A shared client the core downloads through -- rule sets, a dashboard, a
// certificate -- named by its tag wherever one is wanted.
export interface HttpClient {
    tag: string;
    version?: number;
    engine?: string;
    detour?: string;
    [option: string]: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Only the shape each tab can edit is read from the document. Other options
// under either key remain in the objects and are carried through untouched.
export const ntpOf = (config: CoreConfig | undefined): Ntp | undefined =>
    isPlainObject(config?.ntp) ? config.ntp : undefined;

export const httpClientsOf = (config: CoreConfig | undefined): HttpClient[] =>
    Array.isArray(config?.http_clients)
        ? config.http_clients.filter(
              (client): client is HttpClient =>
                  isPlainObject(client) && typeof client.tag === "string",
          )
        : [];

// An option cleared on the page is left out rather than written as an empty
// value, which the core would read as one that was set -- at any depth, since
// an HTTP client's options can hold objects of their own.
const cleaned = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(value)
            .filter(([, option]) => option !== undefined && option !== "")
            .map(([key, option]) => [key, isPlainObject(option) ? cleaned(option) : option]),
    );

// Each tab replaces only its own key. A clock switched off and a list of
// clients emptied are taken out rather than written as empty values.
export const withNtp = (config: CoreConfig, ntp: Ntp | undefined): CoreConfig =>
    Object.fromEntries(
        Object.entries({
            ...config,
            ntp: ntp && cleaned(ntp),
        }).filter(([, value]) => value !== undefined),
    );

export const withHttpClients = (config: CoreConfig, clients: HttpClient[]): CoreConfig =>
    Object.fromEntries(
        Object.entries({
            ...config,
            http_clients: clients.length ? clients.map((client) => cleaned(client)) : undefined,
        }).filter(([, value]) => value !== undefined),
    );

export const isNtpChanged = (config: CoreConfig | undefined, ntp: Ntp | undefined) =>
    JSON.stringify(ntpOf(config)) !== JSON.stringify(ntpOf(withNtp(config ?? {}, ntp)));

export const isHttpClientsChanged = (config: CoreConfig | undefined, clients: HttpClient[]) =>
    JSON.stringify(httpClientsOf(config)) !==
    JSON.stringify(httpClientsOf(withHttpClients(config ?? {}, clients)));

// Where the proxy core documents each part, for the link beside a panel's title.
const DOCS = "https://sing-box.sagernet.org/configuration";

export const DOC_LINKS = {
    ntp: `${DOCS}/ntp/`,
};

// What a clock the node keeps starts on, as the reference starts one.
export const NTP_DEFAULTS = { server: "time.apple.com", server_port: 123, interval: "30m" };

// How often the clock is set, in minutes, as the core writes it -- "30m", or
// "1h" for a whole number of hours. Null for a value in any other shape, which
// is then kept as it was written rather than read wrongly.
export const intervalMinutes = (interval: unknown) => {
    if (typeof interval !== "string") {
        return null;
    }

    const minutes = /^(\d+)m$/.exec(interval);
    const hours = /^(\d+)h$/.exec(interval);

    return minutes ? Number(minutes[1]) : hours ? Number(hours[1]) * 60 : null;
};

// The HTTP versions a client can speak, by the names the reference gives them.
// Nought lets the client choose.
export const HTTP_VERSIONS = [
    { value: 0, name: "Auto" },
    { value: 1, name: "HTTP/1.1" },
    { value: 2, name: "HTTP/2" },
    { value: 3, name: "HTTP/3" },
];

export const httpVersionName = (version: unknown) =>
    HTTP_VERSIONS.find((known) => known.value === (typeof version === "number" ? version : 0))
        ?.name ?? String(version);

// The engines the core can make requests with; left out, the default one.
export const HTTP_ENGINES = ["go", "apple"];

const parseDocument = (document: string): Record<string, unknown> | null => {
    if (!document.trim()) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(document);

        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const CLIENT_FIELDS = new Set(["tag", "version", "engine", "detour"]);

export const httpClientRequest = z.object({
    // What a rule set, a dashboard or a provider names it by.
    tag: z
        .string()
        .min(1, "Enter a tag.")
        .max(64, "Use 64 characters or fewer.")
        .regex(/^\S+$/, "Use no spaces."),
    version: z.string(),
    engine: z.string(),
    // The route out it makes its requests through, or none for the default.
    detour: z.string(),
    options: z
        .string()
        .refine(
            (document) => parseDocument(document) !== null,
            "Use a JSON object, or leave it empty.",
        ),
});

export type HttpClientRequest = z.infer<typeof httpClientRequest>;

export const fromHttpClient = (client: HttpClient): HttpClientRequest => {
    const rest = Object.fromEntries(
        Object.entries(client).filter(([key]) => !CLIENT_FIELDS.has(key)),
    );

    return {
        tag: client.tag,
        version: String(typeof client.version === "number" ? client.version : 0),
        engine: typeof client.engine === "string" ? client.engine : "",
        detour: typeof client.detour === "string" ? client.detour : "",
        options: Object.keys(rest).length ? JSON.stringify(rest, null, 4) : "",
    };
};

// Only what was chosen is written: Auto, the default engine and no detour are
// what the core does with the key left out.
export const toHttpClient = ({
    tag,
    version,
    engine,
    detour,
    options,
}: HttpClientRequest): HttpClient => ({
    tag,
    ...(Number(version) ? { version: Number(version) } : {}),
    ...(engine ? { engine } : {}),
    ...(detour ? { detour } : {}),
    ...Object.fromEntries(
        Object.entries(parseDocument(options) ?? {}).filter(([key]) => !CLIENT_FIELDS.has(key)),
    ),
});
