import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { request } from "@/lib/request";

// A subscriber of the tunnel, as /clients describes one. It is the record that
// carries a quota, an expiry and the traffic counted against them.
export interface Client {
    id: number;
    enable: boolean;
    name: string;
    desc: string;
    group: string;
    remark: string;
    // A quota in bytes; 0 is unlimited.
    volume: number;
    // A unix time; 0 never expires.
    expiry: number;
    // Traffic in the current period.
    up: number;
    down: number;
    // Traffic from every period before this one, kept across a reset.
    totalUp: number;
    totalDown: number;
    createdAt: number;
    onlineAt: number;
    delayStart: boolean;
    autoReset: boolean;
    resetDays: number;
    nextReset: number;
    // The listeners this subscriber may connect through, by id. Their
    // subscription is built from these, so a subscriber with none has a link
    // that resolves to nothing -- and the API takes what is sent as the whole
    // set rather than merging it, so an edit has to carry the current one back.
    inbounds?: number[];
    // The credentials they authenticate with, one identity per protocol. Only a
    // subscriber read on their own carries them: the listing leaves them out.
    config?: ClientConfig;
}

// A subscriber's identities by protocol, each a set of credentials by name --
// a uuid, a password -- beside the name the API keeps in step with their own.
export type ClientConfig = Record<string, Record<string, unknown>>;

// How a credential is drawn, which is how the API mints its own: a version 4
// UUID, a secret of 24 random bytes written URL-safe, or a key of exactly the
// size a shadowsocks 2022 method reads, in standard base64 -- a core refuses the
// whole configuration over a key of any other length.
type Draw = "uuid" | "secret" | "key16" | "key32";

// The credentials the Config tab shows, per identity, in the reference's order.
// A vless flow is chosen rather than drawn, and nothing is drawn in its place.
export interface IdentityField {
    name: string;
    label: string;
    draw?: Draw;
    choices?: string[];
}

const PASSWORD: IdentityField = { name: "password", label: "Password", draw: "secret" };
const UUID: IdentityField = { name: "uuid", label: "UUID", draw: "uuid" };

export const IDENTITIES: { key: string; fields: IdentityField[] }[] = [
    { key: "socks", fields: [PASSWORD] },
    { key: "http", fields: [PASSWORD] },
    { key: "shadowsocks", fields: [{ ...PASSWORD, draw: "key32" }] },
    { key: "shadowsocks16", fields: [{ ...PASSWORD, draw: "key16" }] },
    { key: "shadowtls", fields: [PASSWORD] },
    { key: "vmess", fields: [UUID] },
    {
        key: "vless",
        fields: [UUID, { name: "flow", label: "Flow", choices: ["xtls-rprx-vision"] }],
    },
    { key: "anytls", fields: [PASSWORD] },
    { key: "trojan", fields: [PASSWORD] },
    { key: "naive", fields: [PASSWORD] },
    { key: "hysteria", fields: [{ name: "auth_str", label: "Auth", draw: "secret" }] },
    { key: "snell", fields: [{ name: "userkey", label: "User key", draw: "secret" }] },
    { key: "tuic", fields: [PASSWORD, UUID] },
    { key: "hysteria2", fields: [PASSWORD] },
];

const randomBytes = (count: number) => crypto.getRandomValues(new Uint8Array(count));

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// Drawn from getRandomValues rather than randomUUID, which a browser only offers
// a page served securely, and a panel is often reached over plain HTTP at the
// address of its host.
const drawUuid = () => {
    const bytes = randomBytes(16);

    // Version 4, variant RFC 4122: several cores check these bits and refuse a
    // uuid that does not carry them.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join("-");
};

const drawCredential = (draw: Draw) => {
    switch (draw) {
        case "uuid":
            return drawUuid();
        case "key16":
            return toBase64(randomBytes(16));
        case "key32":
            return toBase64(randomBytes(32));
        case "secret":
            // Twenty-four bytes come out with no padding to take off.
            return toBase64(randomBytes(24)).replace(/\+/g, "-").replace(/\//g, "_");
    }
};

// A credential left empty is one the API mints when the subscriber is saved, for
// the listeners that need it, so it is left out rather than sent as nothing, and
// an identity with nothing left in it goes with it. What is sent replaces what
// is stored, so an identity that is cleared this way is minted afresh wherever
// it is needed.
export const withoutEmptyCredentials = (config: ClientConfig): ClientConfig =>
    Object.fromEntries(
        Object.entries(config)
            .map(
                ([key, identity]) =>
                    [
                        key,
                        Object.fromEntries(
                            Object.entries(identity).filter(([, value]) => value !== ""),
                        ),
                    ] as const,
            )
            .filter(([, identity]) => Object.keys(identity).length > 0),
    );

// Every credential of one identity, or of every identity when none is named,
// drawn afresh at once, as the reference draws them: what a new subscriber is
// opened with, and what Reset asks for. They are shown before the save puts them
// into use, which is when a client application holding the old ones stops
// connecting. A field chosen rather than drawn -- a vless flow -- keeps what it
// has, and so does whatever else an identity carries: the name the API keeps in
// step with the subscriber's, and any identity the panel does not know.
export const withIdentityDrawn = (config: ClientConfig, key?: string): ClientConfig => ({
    ...config,
    ...Object.fromEntries(
        IDENTITIES.filter((identity) => key === undefined || identity.key === key).map(
            ({ key: identityKey, fields }) =>
                [
                    identityKey,
                    {
                        ...config[identityKey],
                        ...Object.fromEntries(
                            fields.flatMap(({ name, draw }) =>
                                draw ? [[name, drawCredential(draw)] as const] : [],
                            ),
                        ),
                    },
                ] as const,
        ),
    ),
});

export interface ClientPage {
    clients: Client[];
    total: number;
    limit: number;
    offset: number;
}

export const CLIENTS_KEY = "/clients";

// A quota is stored in bytes and typed in gigabytes: nobody sells a subscription
// by the byte, and typing one out is how a zero goes missing.
export const BYTES_PER_GIGABYTE = 1024 ** 3;

export const fromVolume = (bytes: number) => bytes / BYTES_PER_GIGABYTE;

export const toVolume = (gigabytes: number) => Math.round(gigabytes * BYTES_PER_GIGABYTE);

// The most the API will take, read in the unit a quota is typed in. Beyond this
// the byte count stops being exact in a double.
export const MAXIMUM_VOLUME = 1_000_000;

// The longest a periodic reset may be set to, which is what the API allows.
export const MAXIMUM_RESET_DAYS = 365;

// Writing a subscriber and amending one ask for the same things, so they are
// held to one shape rather than two that would have to be kept alike.
//
// What is checked here is the shape the API asks for rather than a second
// opinion on who may be a subscriber: the API is the authority, and what it
// refuses is read back from it.
export const clientRequest = z
    .object({
        name: z
            .string()
            .min(1, "Enter a name.")
            .max(64, "Use 64 characters or fewer.")
            // The name is the subscription id, so it travels in a URL. A space
            // or a slash in one is a link that does not resolve.
            .regex(/^[^\s/?#]+$/, "Use no spaces, slashes, question marks or hashes."),
        enable: z.boolean(),
        desc: z.string().max(500, "Use 500 characters or fewer."),
        group: z.string().max(64, "Use 64 characters or fewer."),
        remark: z.string().max(500, "Use 500 characters or fewer."),
        // Typed in gigabytes and billed in bytes, so what is checked is the
        // figure that was typed and the unit is put back on it on the way out.
        volume: z
            .number("Use an amount.")
            .min(0, "Use nothing less than zero.")
            .max(MAXIMUM_VOLUME, `Use ${MAXIMUM_VOLUME.toLocaleString("en-US")} or less.`),
        // A date the subscription runs to, or empty for one that never expires.
        expiry: z.string(),
        delayStart: z.boolean(),
        autoReset: z.boolean(),
        resetDays: z
            .number("Use a whole number.")
            .int("Use a whole number.")
            .min(0, "Use nothing less than zero.")
            .max(MAXIMUM_RESET_DAYS, `Use ${MAXIMUM_RESET_DAYS} or fewer.`),
        // Which inbounds this subscriber may connect through.
        inbounds: z.array(z.number()),
        // Their credentials, when they were read: left out, the API keeps the
        // ones it holds, which is what an edit that never saw them has to do.
        config: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    })
    .refine((values) => !(values.autoReset || values.delayStart) || values.resetDays > 0, {
        // At zero days the next reset lands on the moment it is computed, so the
        // quota resets every time the worker runs and is never reached; and a
        // held clock is started as that many days, so it would end as it began.
        message: "Use at least one day.",
        path: ["resetDays"],
    });

export type ClientRequest = z.infer<typeof clientRequest>;

// A date field holds what a person typed; the API counts in unix seconds. An
// empty field is a subscription that never expires rather than one expiring at
// the epoch.
export const toExpiry = (value: string) => {
    if (!value) {
        return 0;
    }

    const parsed = Date.parse(`${value}T23:59:59`);

    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
};

export const fromExpiry = (expiry: number) => {
    if (!expiry) {
        return "";
    }

    // `toISOString` is UTC and a date field is read locally, so the offset is
    // taken off first. Without it a subscription set to expire today reads as
    // yesterday for anyone west of Greenwich.
    const date = new Date(expiry * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

    return local.toISOString().slice(0, 10);
};

// The credentials go only when the form held them. What is sent replaces what is
// stored, so a form that never read them must not send an empty set: the API
// would mint new ones and every client application holding the old would stop.
export const toClientPayload = ({ volume, expiry, config, ...rest }: ClientRequest) => ({
    ...rest,
    volume: toVolume(volume),
    expiry: toExpiry(expiry),
    ...(config ? { config: withoutEmptyCredentials(config) } : {}),
});

// What is stored read back as what is edited: a quota is kept in bytes and read
// in gigabytes, and an expiry is kept as a unix time and read as a date.
//
// The inbound list matters more than it looks. The API replaces it with whatever
// an update sends rather than merging, so a form that opened without it would
// post an empty one and quietly cut the subscriber off from every listener they
// were connecting through.
export const fromClient = (client: Client): ClientRequest => ({
    name: client.name,
    enable: client.enable,
    desc: client.desc,
    group: client.group,
    remark: client.remark,
    volume: fromVolume(client.volume),
    expiry: fromExpiry(client.expiry),
    delayStart: client.delayStart,
    autoReset: client.autoReset,
    resetDays: client.resetDays,
    inbounds: client.inbounds ?? [],
    // Only a subscriber read on their own has these; one from the listing
    // leaves them out, and so does the edit made from it.
    config: client.config,
});

export const CLIENT_GROUPS_KEY = "/client-groups";
export const SUBSCRIPTION_URI_KEY = "/subscription-uri";

// Where subscribers fetch from, for the whole deployment. The API assembles it
// from the subscription listener's own configuration, so the panel does not have
// to know a port or a mount point it is not served on.
export interface SubscriptionBase {
    uri: string;
    enabled: boolean;
}

export const useSubscriptionBase = () => {
    return useSWR<SubscriptionBase, Error>(SUBSCRIPTION_URI_KEY, () =>
        request.get<SubscriptionBase>(SUBSCRIPTION_URI_KEY),
    );
};

// A subscriber's own subscription URL: the deployment's base with their name on
// the end. The name is the subscription id, which is why renaming one breaks
// every client application holding the old link.
export const subscriptionURL = (base: string, name: string) =>
    `${base.replace(/\/$/, "")}/${encodeURIComponent(name)}`;

// How many subscribers a page holds to begin with, and what else it can be set to.
// Ten is a screen's worth, which is where the reference starts; the rest are for
// an operator who would rather scroll than page.
export const CLIENTS_PER_PAGE = 10;
export const PAGE_SIZES = [10, 25, 50, 100];

// What narrows the listing. The API does the filtering rather than the panel,
// so a search runs against every subscriber rather than only the page in hand.
export interface ClientFilter {
    group: string;
    search: string;
    // Undefined is either, which is not the same as false.
    enabled?: boolean;
    offset: number;
}

export const emptyFilter: ClientFilter = {
    group: "",
    search: "",
    enabled: undefined,
    offset: 0,
};

// The query the filter reads as. Only what narrows anything is sent, so the
// SWR key of an unfiltered listing stays the plain path and does not change
// shape the first time a filter is cleared. How many a page holds is not part of
// the filter, so clearing one leaves the page size where it was.
export const toClientQuery = (filter: ClientFilter, limit = CLIENTS_PER_PAGE) => {
    const query = new URLSearchParams();

    if (filter.group) {
        query.set("group", filter.group);
    }
    if (filter.search) {
        query.set("search", filter.search);
    }
    if (filter.enabled !== undefined) {
        query.set("enabled", String(filter.enabled));
    }
    if (filter.offset) {
        query.set("offset", String(filter.offset));
    }
    query.set("limit", String(limit));

    return `${CLIENTS_KEY}?${query.toString()}`;
};

export const getClients = async (url: string) => {
    return request.get<ClientPage>(url);
};

// The key is the URL, so a filter or a page is a read of its own and going back
// to one already seen is answered from cache.
export const useClients = (filter: ClientFilter = emptyFilter, limit = CLIENTS_PER_PAGE) => {
    return useSWR<ClientPage, Error>(toClientQuery(filter, limit), getClients, {
        // Rows that stay put while the next page loads, rather than a table that
        // empties and refills under whoever was reading it.
        keepPreviousData: true,
    });
};

// One subscriber whole, credentials and all, which is what an edit is made from:
// the listing leaves the credentials out. Under the clients path, so a write to
// them is read again here too.
export const useClient = (clientId: number) => {
    return useSWR<Client, Error>(`${CLIENTS_KEY}/${clientId}`, () =>
        request.get<Client>(`${CLIENTS_KEY}/${clientId}`),
    );
};

// The groups in use, for the filter to offer. Read from the API rather than
// gathered from the page in hand, which would only ever know the groups of the
// subscribers already on screen.
export const useClientGroups = () => {
    return useSWR<string[], Error>(CLIENT_GROUPS_KEY, () =>
        request.get<string[]>(CLIENT_GROUPS_KEY),
    );
};

// Every listing is read under a key beginning with the clients path, so a
// subscriber that was written, changed or taken away is asked for again on
// whichever page and filter is in hand rather than only on the unfiltered one.
// The group list goes with them: a write may have introduced a group or emptied
// the last subscriber out of one.
const useRevalidateClients = () => {
    const { mutate } = useSWRConfig();

    return () =>
        mutate(
            (key) =>
                typeof key === "string" &&
                (key.startsWith(CLIENTS_KEY) || key === CLIENT_GROUPS_KEY),
        );
};

export const createClient = async (payload: ClientRequest) => {
    return request.post<Client>(CLIENTS_KEY, toClientPayload(payload));
};

// `trigger` resolves with nothing rather than throwing on a rejected call, so a
// caller reads the outcome from what it hands back and the hook holds the error.
export const useCreateClient = () => {
    const revalidate = useRevalidateClients();

    return useSWRMutation(
        CLIENTS_KEY,
        (_key: string, { arg }: { arg: ClientRequest }) => createClient(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const updateClient = async (clientId: number, payload: ClientRequest) => {
    return request.post<Client>(`${CLIENTS_KEY}/${clientId}`, toClientPayload(payload));
};

export const useUpdateClient = () => {
    const revalidate = useRevalidateClients();

    return useSWRMutation(
        CLIENTS_KEY,
        (_key: string, { arg }: { arg: { id: number; changes: ClientRequest } }) =>
            updateClient(arg.id, arg.changes),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

// A subscriber switched on or off from the table rather than the form. The
// record is read afresh and sent back whole with the one field changed: the API
// replaces what it is sent rather than merging it, the listing is a summary that
// leaves out their credentials, and a round trip through the form's own units
// would move an expiry to the end of its day.
export const setClientEnabled = async (clientId: number, enable: boolean) => {
    const client = await request.get<Client>(`${CLIENTS_KEY}/${clientId}`);

    return request.post<Client>(`${CLIENTS_KEY}/${clientId}`, { ...client, enable });
};

export const useSetClientEnabled = () => {
    const revalidate = useRevalidateClients();

    return useSWRMutation(
        `${CLIENTS_KEY}/enable`,
        (_key: string, { arg }: { arg: { id: number; enable: boolean } }) =>
            setClientEnabled(arg.id, arg.enable),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

// The API answers a deletion with nothing of its own, and a call that was
// refused answers with nothing either, so read straight back the two would be
// the same. The subscriber that was taken away is what this answers with
// instead, which is something a caller can tell one from the other by.
export const deleteClient = async (clientId: number) => {
    await request.delete(`${CLIENTS_KEY}/${clientId}`);

    return clientId;
};

export const useDeleteClient = () => {
    const revalidate = useRevalidateClients();

    return useSWRMutation(
        CLIENTS_KEY,
        (_key: string, { arg }: { arg: number }) => deleteClient(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const getClientLinks = async (clientId: number) => {
    return request.get<string[]>(`${CLIENTS_KEY}/${clientId}/links`);
};

// Links are built by the API on read rather than stored, so a change to an
// inbound shows up here without anything being regenerated.
export const useClientLinks = (clientId: number) => {
    return useSWR<string[], Error>(`${CLIENTS_KEY}/${clientId}/links`, () =>
        getClientLinks(clientId),
    );
};

export const resetClientTraffic = async (clientId: number) => {
    await request.post(`${CLIENTS_KEY}/${clientId}/reset-traffic`);

    return clientId;
};

export const useResetClientTraffic = () => {
    const revalidate = useRevalidateClients();

    return useSWRMutation(
        `${CLIENTS_KEY}/reset-traffic`,
        (_key: string, { arg }: { arg: number }) => resetClientTraffic(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const TRAFFIC_RESET_KEY = "/traffic/reset";

// Every subscriber's period rolled into their lifetime totals at once, and whoever
// was held offline for running out let back on. The API answers with how many
// subscribers that touched.
export const resetAllTraffic = async () => {
    return request.post<{ reset: number }>(TRAFFIC_RESET_KEY);
};

export const useResetAllTraffic = () => {
    const revalidate = useRevalidateClients();

    return useSWRMutation(TRAFFIC_RESET_KEY, () => resetAllTraffic(), {
        throwOnError: false,
        onSuccess: revalidate,
    });
};

// What a subscriber has spent in the current period, which is what their quota
// is held against.
export const usedBytes = (client: Client) => client.up + client.down;

// How much of the quota is gone, for a meter. An unlimited subscriber has no
// proportion to show.
export const usedFraction = (client: Client) => {
    if (client.volume <= 0) {
        return null;
    }

    return Math.min(usedBytes(client) / client.volume, 1);
};

// Where a quota stands, which is the colour its figure is drawn in: nothing to run
// out of, all of it gone, or somewhere between.
export type QuotaState = "unlimited" | "spent" | "running";

export const quotaState = (client: Client): QuotaState => {
    if (client.volume <= 0) {
        return "unlimited";
    }

    return usedBytes(client) >= client.volume ? "spent" : "running";
};

// The colour of the bar under a quota: fine until its last tenth, a warning within
// it, and spent once it is gone.
export const quotaTone = (client: Client) => {
    const fraction = usedFraction(client) ?? 0;

    if (fraction >= 1) {
        return "danger";
    }

    return fraction > 0.9 ? "attention" : "success";
};

const SECONDS_PER_DAY = 86_400;

// Where an expiry stands at a moment given in milliseconds, the way a clock reads
// it: never coming, already past, or still to come.
export type ExpiryState = "never" | "expired" | "running";

export const expiryState = (client: Client, now: number): ExpiryState => {
    if (!client.expiry) {
        return "never";
    }

    return client.expiry <= now / 1000 ? "expired" : "running";
};

// The whole days left before a subscription runs out, which is what the table
// shows of an expiry: the date and the hour are for the tooltip beside it.
export const daysLeft = (client: Client, now: number) =>
    Math.floor((client.expiry - now / 1000) / SECONDS_PER_DAY);
