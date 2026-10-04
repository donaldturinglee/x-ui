import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { CLIENTS_KEY, getClients, type Client, type ClientPage } from "@/features/clients/api";
import { CONFIG_BASE_KEY, CONFIG_KEY } from "@/features/config/api";
import { STATS_KEY } from "@/features/diagnostics/api";
import { ONLINES_KEY } from "@/features/overview/api";
import { request } from "@/lib/request";

import { securityOf } from "./tls";
import { isShareDomain, readShareAddress, withShareAddress } from "./share-address";

export {
    hasListenOption,
    udpTimeoutMinutes,
    withListenOption,
    withoutListenOptions,
} from "@/lib/listen";

// A listener clients connect to.
//
// Only the fields the panel reasons about have names of their own. Every other
// option the proxy core accepts for that listener type is stored verbatim and
// arrives alongside them, which is what lets a new core release add options
// without the panel being changed. Its TLS is one of them: see `./tls`.
export interface Inbound {
    id: number;
    type: string;
    tag: string;
    addrs?: unknown;
    out_json?: unknown;
    [option: string]: unknown;
}

export const INBOUNDS_KEY = "/inbounds";

// The listener types the proxy core accepts, in the order its own documentation
// lists them. Offered as a list rather than typed out, because "vmess" spelled
// "vmesss" is a listener the core refuses at startup and a panel that took the
// word for it is one that let an operator do that.
//
// A record whose type is not here is still editable: the form keeps the value it
// found rather than quietly rewriting it to whichever happens to be first, so a
// type from a newer core release survives an edit made for some other reason.
export const INBOUND_TYPES = [
    "anytls",
    "cloudflared",
    "direct",
    "http",
    "hysteria",
    "hysteria2",
    "mixed",
    "naive",
    "redirect",
    "shadowsocks",
    "shadowtls",
    "snell",
    "socks",
    "tproxy",
    "trojan",
    "tuic",
    "tun",
    "vless",
    "vmess",
];

// The highest port there is. Zero is "not set" rather than a port, which is what
// a listener type that binds nothing -- tun, cloudflared -- has.
export const MAXIMUM_PORT = 65535;

// The types that listen on an address and port of their own. A tun listener is
// an interface on the host rather than a socket, and a cloudflared one dials out
// to Cloudflare's edge; the core refuses listen options on either.
const LISTENLESS_TYPES = new Set(["tun", "cloudflared"]);

export const listensOn = (type: string) => !LISTENLESS_TYPES.has(type);

// The types TLS can be put in front of, as the reference lists them, and of
// those the ones that are only ever served over it.
const TLS_TYPES = new Set([
    "http",
    "vmess",
    "trojan",
    "naive",
    "hysteria",
    "tuic",
    "hysteria2",
    "vless",
    "anytls",
]);
const TLS_ONLY_TYPES = new Set(["hysteria", "hysteria2", "tuic", "naive", "anytls"]);

// Of those, the ones Reality can be put in front of: the types served over a
// stream a handshake can be borrowed on. Over QUIC -- hysteria, hysteria2, tuic
// and naive's HTTP/3 -- the core has no Reality to serve, and refuses to start
// with one; nor does a naive client speak it.
const REALITY_TYPES = new Set(["http", "vmess", "trojan", "vless", "anytls"]);

export const carriesTls = (type: string) => TLS_TYPES.has(type);

export const carriesReality = (type: string) => REALITY_TYPES.has(type);

// Where the proxy core documents a listener type, or its listeners as a whole
// before a type is chosen.
export const inboundDoc = (type: string) =>
    `https://sing-box.sagernet.org/configuration/inbound/${type ? `${type}/` : ""}`;

// That page as the mark in a dialog's title leads to it, read out by the type.
export const inboundDocs = (type: string) => ({
    href: inboundDoc(type),
    label: type ? `${type} listener` : "Listener",
});

// The fields the form has of its own. Everything else a listener carries is an
// option the proxy core accepts for its type: the panel does not model those,
// which is exactly why it must not drop them. They are gathered into a document
// the form carries unseen and sent back whole.
//
// listen and listen_port earned names here because they are on almost every
// listener and are the two an operator sets most: leaving them in the document
// meant nothing in the panel could change a port. A listener's TLS stays in the
// document -- it is one of the core's options -- and its fields are views over
// it there.
const NAMED_FIELDS = new Set(["id", "type", "tag", "listen", "listen_port", "share_address"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Reads the options document, or null when it is not a JSON object. One reader
// for both the check and the send, so the document a form accepted is the one
// that goes out. Nothing types this any more, but a record read back from the
// API is still only as well-formed as the API made it.
export const parseOptions = (document: string): Record<string, unknown> | null => {
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

export const isOptionsDocument = (document: string) => parseOptions(document) !== null;

// Options written as the document the form carries. Nothing is a listener with
// no options at all, so an empty one reads as empty rather than as a pair of
// braces.
export const optionsDocument = (options: Record<string, unknown>) =>
    Object.keys(options).length ? JSON.stringify(options, null, 4) : "";

// What is left of a listener once the named fields are taken out, written as the
// document the form carries through an edit untouched.
export const toOptionsDocument = (inbound: Inbound) =>
    optionsDocument(
        Object.fromEntries(Object.entries(inbound).filter(([key]) => !NAMED_FIELDS.has(key))),
    );

// Writing a listener and amending one ask for the same things, so they are held
// to one shape rather than two that would have to be kept alike.
//
// What is checked here is the shape the API asks for rather than a second
// opinion on what a listener may be: the API is the authority, and what it
// refuses is read back from it.
export const inboundRequest = z
    .object({
        // Chosen from the list above rather than typed. It is still only checked for
        // being something: the core is the authority on which types it serves, and a
        // record carrying one this panel has not heard of is edited rather than
        // refused.
        type: z
            .string()
            .min(1, "Choose a type.")
            .max(64, "Use 64 characters or fewer.")
            .regex(/^\S+$/, "Use no spaces."),
        // Traffic is reported against this and route rules name it, so it is what
        // ties a listener to everything said about it elsewhere.
        tag: z
            .string()
            .trim()
            .min(1, "Enter a tag.")
            .max(64, "Use 64 characters or fewer.")
            .regex(/^\S+$/, "Use no spaces."),
        // Empty binds every interface, which is what most deployments want and what
        // the core does with no value at all.
        listen: z.string().max(64, "Use 64 characters or fewer.").regex(/^\S*$/, "Use no spaces."),
        // Named as the record stores it: what goes over the wire and what the form
        // holds are then the same word.
        listen_port: z
            .number("Use a whole number.")
            .int("Use a whole number.")
            .min(0, "Use nothing less than zero.")
            .max(MAXIMUM_PORT, `Use ${MAXIMUM_PORT} or less.`),
        // A view over the first published address, kept out of the core options.
        share_address: z.string().trim(),
        // How the listener is served. The block that says so is in the options,
        // and is what is sent; this is the choice that wrote it, held beside them
        // so what the core would refuse is said under the field that chose it.
        security: z.enum(["none", "tls", "reality"]),
        // Every option the core accepts for this type, as the JSON it is stored as.
        // Only the listen options and the TLS are edited in it: the form holds what
        // was read and hands the rest back, which is what keeps a transport or a
        // user list from being dropped by an edit that only meant to change a port.
        options: z.string().refine(isOptionsDocument, "Use a JSON object, or leave it empty."),
    })
    // A type that is only ever served over TLS is refused by the core without it,
    // so the form refuses it first, as the reference does; and one served over
    // QUIC has no Reality to be served over. A type this panel does not know is
    // left to the core.
    .superRefine(({ type, security, share_address, listen_port, options }, context) => {
        const listener = `${/^[aeiou]/.test(type) ? "An" : "A"} ${type} listener`;

        if (TLS_ONLY_TYPES.has(type) && security === "none") {
            context.addIssue({
                code: "custom",
                path: ["security"],
                message: `${listener} is only served over TLS: choose ${carriesReality(type) ? "TLS or Reality" : "TLS"}.`,
            });
        }

        if (carriesTls(type) && !carriesReality(type) && security === "reality") {
            context.addIssue({
                code: "custom",
                path: ["security"],
                message: `${listener} cannot be served over Reality: choose TLS.`,
            });
        }

        if (supportsSharing(type)) {
            if (listen_port < 1) {
                context.addIssue({
                    code: "custom",
                    path: ["listen_port"],
                    message: "Enter a port from 1 to 65535.",
                });
            }

            // Preserve an existing IP or older address on an ordinary edit.
            // A new or changed value must be a domain without a port.
            if (
                share_address &&
                share_address !== readShareAddress(parseOptions(options) ?? {}) &&
                !isShareDomain(share_address)
            ) {
                context.addIssue({
                    code: "custom",
                    path: ["share_address"],
                    message: "Enter a domain only, without a scheme, port or path.",
                });
            }
        }
    });

export type InboundRequest = z.infer<typeof inboundRequest>;

// The named fields are spread last, so a key carried along in the options
// document cannot quietly override the tag or the type that was filled in.
//
// listen and listen_port are left out when they are empty rather than sent as ""
// and 0. A listener type that binds nothing has neither key, and writing them in
// would be the panel inventing configuration the core never had -- which the
// next generation would carry to the node.
//
// The security is not sent: it is the TLS block in the options that says it.
// Edits carry their original port so an unrelated save preserves a separately
// published port. New listeners and copies publish the port they are given.
export const toInboundPayload = (
    { options, listen, listen_port, share_address, security: _security, ...named }: InboundRequest,
    original?: Inbound,
): Record<string, unknown> & {
    type: string;
    tag: string;
    listen?: string;
    listen_port?: number;
} => {
    const document = parseOptions(options) ?? {};
    const published = supportsSharing(named.type)
        ? withShareAddress(
              document,
              share_address.trim(),
              listen_port,
              !original || listen_port !== (listenPort(original) ?? 0),
          )
        : document;

    return {
        ...published,
        ...named,
        ...(listen ? { listen } : {}),
        ...(listen_port ? { listen_port } : {}),
    };
};

export const fromInbound = (inbound: Inbound): InboundRequest => ({
    type: inbound.type,
    tag: inbound.tag,
    listen: typeof inbound.listen === "string" ? inbound.listen : "",
    listen_port: listenPort(inbound) ?? 0,
    share_address: readShareAddress(inbound),
    security: securityOf(inbound),
    options: toOptionsDocument(inbound),
});

// A copy's tag is its type, a dash and a few of these: enough of them that two
// copies made a moment apart do not collide, few enough that the tag still reads
// as the type.
const CLONE_TAG_CHARACTERS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CLONE_TAG_LENGTH = 3;

// How many tags are drawn before giving up on finding one that is free. Chance
// alone does not get this far, so whatever does is left for the API to refuse.
const CLONE_TAG_ATTEMPTS = 10;

// Where a copy's port is drawn from, which is the range the reference draws from:
// clear of the low ports a host's own services tend to hold.
const CLONE_PORT_MINIMUM = 10_000;
const CLONE_PORT_MAXIMUM = 60_000;

// A second listener made from one that exists: everything it carries, under a tag
// and on a port of its own. Those are the two that change because the API refuses
// a tag that is taken and a node cannot bind one port twice. A type that binds no
// port -- tun, redirect -- keeps binding none.
//
// The subscribers connecting through the original are not carried over. They name
// the listeners they use rather than the other way round, so the copy starts with
// nobody until one of them is given it.
export const cloneInbound = (
    inbound: Inbound,
    takenTags: string[],
    random: () => number = Math.random,
): InboundRequest => {
    const pick = (count: number) => Math.floor(random() * count);
    const taken = new Set(takenTags);

    const drawTag = () =>
        `${inbound.type}-${Array.from(
            { length: CLONE_TAG_LENGTH },
            () => CLONE_TAG_CHARACTERS[pick(CLONE_TAG_CHARACTERS.length)],
        ).join("")}`;

    let tag = drawTag();

    for (let attempt = 1; attempt < CLONE_TAG_ATTEMPTS && taken.has(tag); attempt++) {
        tag = drawTag();
    }

    const original = fromInbound(inbound);

    return {
        ...original,
        tag,
        listen_port: original.listen_port
            ? CLONE_PORT_MINIMUM + pick(CLONE_PORT_MAXIMUM - CLONE_PORT_MINIMUM + 1)
            : 0,
    };
};

export const getInbounds = async () => {
    return request.get<Inbound[]>(INBOUNDS_KEY);
};

export const useInbounds = () => {
    return useSWR<Inbound[], Error>(INBOUNDS_KEY, getInbounds);
};

// The listing is read under one key, so a listener that was written, changed or
// taken away is asked for again wherever it could be read.
const useRevalidateInbounds = () => {
    const { mutate } = useSWRConfig();

    return () => mutate(INBOUNDS_KEY);
};

export const createInbound = async (payload: InboundRequest) => {
    return request.post<Inbound>(INBOUNDS_KEY, toInboundPayload(payload));
};

// `trigger` resolves with nothing rather than throwing on a rejected call, so a
// caller reads the outcome from what it hands back and the hook holds the error.
export const useCreateInbound = () => {
    const revalidate = useRevalidateInbounds();

    return useSWRMutation(
        INBOUNDS_KEY,
        (_key: string, { arg }: { arg: InboundRequest }) => createInbound(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const updateInbound = async (
    inboundId: number,
    payload: InboundRequest,
    original: Inbound,
) => {
    return request.post<Inbound>(
        `${INBOUNDS_KEY}/${inboundId}`,
        toInboundPayload(payload, original),
    );
};

export const useUpdateInbound = () => {
    const { mutate } = useSWRConfig();

    return useSWRMutation(
        INBOUNDS_KEY,
        (
            _key: string,
            { arg }: { arg: { id: number; changes: InboundRequest; original: Inbound } },
        ) => updateInbound(arg.id, arg.changes, arg.original),
        {
            throwOnError: false,
            onSuccess: () =>
                Promise.all([
                    mutate(INBOUNDS_KEY),
                    mutate(CONFIG_BASE_KEY),
                    mutate(CONFIG_KEY),
                    mutate(ONLINES_KEY),
                    mutate(
                        (key) =>
                            typeof key === "string" &&
                            key.startsWith(`${STATS_KEY}?resource=inbound&`),
                    ),
                ]),
        },
    );
};

// The API answers a deletion with nothing of its own, and a call that was
// refused answers with nothing either, so read straight back the two would be
// the same. The listener that was taken away is what this answers with instead,
// which is something a caller can tell one from the other by.
export const deleteInbound = async (inboundId: number) => {
    await request.delete(`${INBOUNDS_KEY}/${inboundId}`);

    return inboundId;
};

export const useDeleteInbound = () => {
    const revalidate = useRevalidateInbounds();

    return useSWRMutation(
        INBOUNDS_KEY,
        (_key: string, { arg }: { arg: number }) => deleteInbound(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

// The port a listener is bound to is one of the options the core accepts rather
// than a field of its own, so it is read off the record rather than typed.
export const listenPort = (inbound: Inbound) => {
    const port = inbound.listen_port;

    return typeof port === "number" ? port : null;
};

// Which listener types a subscriber can be handed a link for. The rest are
// listeners the panel manages but nothing dials directly — a tun device, a
// redirect — and a subscriber has no use for them.
const TYPES_WITH_LINK = new Set([
    "socks",
    "http",
    "mixed",
    "shadowsocks",
    "naive",
    "hysteria",
    "hysteria2",
    "anytls",
    "tuic",
    "vless",
    "trojan",
    "vmess",
]);

export const hasLink = (inbound: Inbound) => TYPES_WITH_LINK.has(inbound.type);

// Snell is published through subscriptions even though it has no sharing URI.
export const supportsSharing = (type: string) => TYPES_WITH_LINK.has(type) || type === "snell";

// The most subscribers the API hands over in one read. Every subscriber is wanted
// here rather than a page of them, so this is what is asked for.
const LARGEST_CLIENT_PAGE = 1000;

// Under the subscribers' own path, so a subscriber written or taken away anywhere
// is asked for again here as well.
export const INBOUND_CLIENTS_KEY = `${CLIENTS_KEY}?limit=${LARGEST_CLIENT_PAGE}`;

// Who connects through each listener. The API answers a listener without them --
// a subscriber names the listeners they may use, not the other way round -- so
// they are read off the subscribers instead.
//
// A panel with more subscribers than one read holds gets a listing that stops
// short, which is what `total` beside it says; a count taken from it is then only
// how many there are at least.
export const useInboundClients = () => {
    return useSWR<ClientPage, Error>(INBOUND_CLIENTS_KEY, getClients);
};

// The names of the subscribers who may connect through a listener, in the order
// the API listed them.
export const clientsOf = (clients: Client[], inboundId: number) =>
    clients.filter((client) => client.inbounds?.includes(inboundId)).map((client) => client.name);
