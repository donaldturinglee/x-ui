import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { CONFIG_BASE_KEY, CONFIG_KEY } from "@/features/config/api";
import { INBOUNDS_KEY } from "@/features/inbounds/api";
import { DIAL_KEYS } from "@/lib/dial";
import { request } from "@/lib/request";

import { outboundCreateIssue, TLS_REQUIRED_TYPES } from "./field-specs";

export { hasDialOption, timeoutSeconds, withDialOption } from "@/lib/dial";

// A route out of the node: where traffic goes once an inbound has accepted it.
//
// Only the fields the panel reasons about have names of their own. Every other
// option the proxy core accepts for that outbound type is stored verbatim and
// arrives alongside them, which is what lets a new core release add options
// without the panel being changed.
export interface Outbound {
    id: number;
    type: string;
    tag: string;
    [option: string]: unknown;
}

export const OUTBOUNDS_KEY = "/outbounds";

export interface OutboundCheckResult {
    ok: boolean;
    delay: number;
    error: string;
    skipped?: boolean;
}

export const checkOutbound = (id: number, signal?: AbortSignal) =>
    request.post<OutboundCheckResult>(
        `${OUTBOUNDS_KEY}/${id}/check`,
        {},
        { signal, timeout: 20_000 },
    );

// Routes offered for creation. WireGuard is stored with the other routes in the
// panel, then rendered as an endpoint for sing-box 1.14.
export const OUTBOUND_TYPES = [
    "direct",
    "block",
    "socks",
    "http",
    "shadowsocks",
    "snell",
    "vmess",
    "trojan",
    "wireguard",
    "naive",
    "hysteria",
    "vless",
    "shadowtls",
    "tuic",
    "hysteria2",
    "anytls",
    "tor",
    "ssh",
    "selector",
    "urltest",
    "bridge",
];

// WireGuard, which the core has run as an endpoint rather than an outbound since
// 1.11 and refused among its outbounds since 1.13: a node refuses the whole
// configuration over one there. The API keeps a WireGuard route out among the
// outbounds all the same and writes it into the endpoints of the configuration
// it generates, which a rule and a detour name by its tag as they name an
// outbound. Here it is a route out like any other, whose options are the ones
// the endpoint takes.
export const WIREGUARD = "wireguard";

// The types with no server of their own to send to: direct and block decide on
// the node, a selector or a URL test hands the traffic to another route out, and
// tor finds its own way. Block and the two that hand traffic on dial nothing
// either, and direct and block have no options of their own besides.
const SERVERLESS_TYPES = new Set(["direct", "block", "selector", "urltest", "tor", "bridge"]);
const DIALLESS_TYPES = new Set(["block", "selector", "urltest", "bridge"]);
const OPTIONLESS_TYPES = new Set(["direct", "block"]);

// A route out whose type is not chosen yet has neither a server nor options of
// its own, which leaves a new one looking as the reference's first does.
export const sendsToServer = (type: string) => type !== "" && !SERVERLESS_TYPES.has(type);
export const dials = (type: string) => !DIALLESS_TYPES.has(type);
export const hasOwnOptions = (type: string) => type !== "" && !OPTIONLESS_TYPES.has(type);

// A block route refuses every connection sent to it, which makes it no route to
// dial through: the core takes one as a detour all the same, and says so only as
// each connection through it fails.
export const refusesAll = (type: string) => type === "block";

// Where the proxy core documents an outbound type, or its outbounds as a whole
// before a type is chosen, as the mark in a dialog's title leads to it. A
// WireGuard route is documented where the core documents it now, as an endpoint.
export const outboundDocs = (type: string) =>
    type === WIREGUARD
        ? {
              href: "https://sing-box.sagernet.org/configuration/endpoint/wireguard/",
              label: "WireGuard",
          }
        : {
              href: `https://sing-box.sagernet.org/configuration/outbound/${type ? `${type}/` : ""}`,
              label: type ? `${type} route out` : "Route out",
          };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Every address there is, which is what a WireGuard route's peer starts out
// allowing: a route out sends on whatever is routed to it, and a peer is only sent
// what falls within the addresses it allows.
const EVERY_ADDRESS = ["0.0.0.0/0", "::/0"];

// The peers of a WireGuard route. The first is the far end of the tunnel, which
// is where the route sends, and is nothing where there is none to read.
const peersOf = (options: Record<string, unknown>): unknown[] =>
    Array.isArray(options.peers) ? options.peers : [];

export const peerOf = (options: Record<string, unknown>) => {
    const [first] = peersOf(options);

    return isPlainObject(first) ? first : {};
};

// The first peer written back with some of its options changed, and any after it
// left as they were.
export const withPeer = (options: Record<string, unknown>, changes: Record<string, unknown>) => ({
    ...options,
    peers: [{ ...peerOf(options), ...changes }, ...peersOf(options).slice(1)],
});

// Where a route out sends, as its two fields show it: the server and the port the
// core takes for every type but WireGuard, which sends to its peer. Each is null
// where there is nothing readable to show.
export const serverOf = (type: string, options: Record<string, unknown>) => {
    const [server, port] =
        type === WIREGUARD
            ? [peerOf(options).address, peerOf(options).port]
            : [options.server, options.server_port];

    return {
        server: typeof server === "string" && server ? server : null,
        port: typeof port === "number" ? port : null,
    };
};

// One of the two written back where the type keeps it. A port cleared is written
// as nothing, which leaves it out of the document.
export const withServerOption = (
    type: string,
    options: Record<string, unknown>,
    field: "server" | "port",
    value: unknown,
) =>
    type === WIREGUARD
        ? withPeer(options, { [field === "server" ? "address" : "port"]: value })
        : { ...options, [field === "server" ? "server" : "server_port"]: value };

// What of a route out's options another type keeps: where it sends to and how
// it dials, as far as that type does either. The rest were the old type's own,
// and the new one starts without them, as the reference starts it. Where it sends
// moves between a server's own keys and a WireGuard route's peer, read the way the
// type it is leaving keeps it, and a peer starts out allowing every address.
export const optionsForType = (options: Record<string, unknown>, type: string, from = "") => {
    const dial = Object.fromEntries(
        Object.entries(options).filter(([key]) => dials(type) && DIAL_KEYS.includes(key)),
    );

    if (!sendsToServer(type)) {
        return dial;
    }

    const { server, port } = serverOf(from, options);
    const withServer = server === null ? {} : withServerOption(type, {}, "server", server);
    const sent = port === null ? withServer : withServerOption(type, withServer, "port", port);

    return {
        ...(type === WIREGUARD ? withPeer(sent, { allowed_ips: [...EVERY_ADDRESS] }) : sent),
        ...dial,
        ...(TLS_REQUIRED_TYPES.has(type) ? { tls: { enabled: true } } : {}),
    };
};

// The fields the form has of its own. Everything else an outbound carries is an
// option the proxy core accepts for its type: the panel does not model those,
// which is exactly why it must not drop them. They are edited as the document
// they are and sent back whole.
const NAMED_FIELDS = new Set(["id", "type", "tag"]);

// Reads the options document, or null when it is not a JSON object. One reader
// for both the check and the send, so the document a form accepted is the one
// that goes out.
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

// Options written as the document an operator edits. A direct outbound has no
// options at all, so an empty one reads as empty rather than as a pair of braces
// to type inside.
export const optionsDocument = (options: Record<string, unknown>) =>
    Object.keys(options).length ? JSON.stringify(options, null, 4) : "";

// What is left of an outbound once the named fields are taken out, written as
// the document an operator edits.
export const toOptionsDocument = (outbound: Outbound) =>
    optionsDocument(
        Object.fromEntries(Object.entries(outbound).filter(([key]) => !NAMED_FIELDS.has(key))),
    );

// Writing a route out and amending one ask for the same things, so they are held
// to one shape rather than two that would have to be kept alike.
//
// What is checked here is the shape the API asks for rather than a second
// opinion on what an outbound may be: the API is the authority, and what it
// refuses is read back from it.
export const outboundRequest = z
    .object({
        // Chosen from the list above rather than typed. It is still only checked for
        // being something: the core is the authority on which types it serves, and
        // a record carrying one this panel has not heard of is edited rather than
        // refused.
        type: z
            .string()
            .min(1, "Choose a type.")
            .max(64, "Use 64 characters or fewer.")
            .regex(/^\S+$/, "Use no spaces."),
        // Route rules detour to an outbound by this name, so it is what ties one to
        // everything said about it elsewhere.
        tag: z
            .string()
            .min(1, "Enter a tag.")
            .max(64, "Use 64 characters or fewer.")
            .regex(/^\S+$/, "Use no spaces."),
        options: z.string().refine(isOptionsDocument, "Use a JSON object, or leave it empty."),
    })
    .superRefine(({ type, options }, context) => {
        if (type !== "shadowsocks") {
            return;
        }

        const parsed = parseOptions(options);
        if (!parsed) {
            return;
        }
        if (typeof parsed.method !== "string" || !parsed.method) {
            context.addIssue({
                code: "custom",
                path: ["options"],
                message: "Choose an encryption method.",
            });
        } else if (typeof parsed.password !== "string" || !parsed.password) {
            context.addIssue({ code: "custom", path: ["options"], message: "Enter a password." });
        }
    });

export type OutboundRequest = z.infer<typeof outboundRequest>;

// Both dialogs use named fields rather than a raw options editor. Validate the
// fields they expose before sending a configuration that sing-box cannot start.
// Editing also accepts a type from a newer core release that this panel has not
// learned to model yet, preserving its options when another field is changed.
export const createOutboundRequest = outboundRequest.superRefine(({ type, options }, context) => {
    const parsed = parseOptions(options);
    if (!parsed || !type) {
        return;
    }

    const issue = outboundCreateIssue(type, parsed);
    if (issue) {
        context.addIssue({
            code: "custom",
            path: [issue.path === "type" ? "type" : "options"],
            message: issue.message,
        });
    }
});

export const editOutboundRequest = outboundRequest.superRefine(({ type, options }, context) => {
    const parsed = parseOptions(options);
    if (!parsed || !OUTBOUND_TYPES.includes(type)) {
        return;
    }

    const issue = outboundCreateIssue(type, parsed);
    if (issue) {
        context.addIssue({
            code: "custom",
            path: [issue.path === "type" ? "type" : "options"],
            message: issue.message,
        });
    }
});

// The named fields are spread last, so a key typed into the options document
// cannot quietly override the tag or the type that was filled in above it.
//
// A block route is sent as those two alone. The core takes nothing else for one
// and the API refuses what is left on it, so options held over from before --
// written by something other than this form -- are let go rather than sent back
// to be refused, from a dialog with no field to take them out.
export const toOutboundPayload = ({ options, ...named }: OutboundRequest) => ({
    ...(refusesAll(named.type) ? {} : (parseOptions(options) ?? {})),
    ...named,
});

export const fromOutbound = (outbound: Outbound): OutboundRequest => ({
    type: outbound.type,
    tag: outbound.tag,
    options: toOptionsDocument(outbound),
});

export const getOutbounds = async () => {
    return request.get<Outbound[]>(OUTBOUNDS_KEY);
};

export const useOutbounds = () => {
    return useSWR<Outbound[], Error>(OUTBOUNDS_KEY, getOutbounds);
};

// The listing is read under one key, so a route out that was written, changed or
// taken away is asked for again wherever it could be read.
const useRevalidateOutbounds = () => {
    const { mutate } = useSWRConfig();

    return () => mutate(OUTBOUNDS_KEY);
};

export const createOutbound = async (payload: OutboundRequest) => {
    return request.post<Outbound>(OUTBOUNDS_KEY, toOutboundPayload(payload));
};

// `trigger` resolves with nothing rather than throwing on a rejected call, so a
// caller reads the outcome from what it hands back and the hook holds the error.
export const useCreateOutbound = () => {
    const revalidate = useRevalidateOutbounds();

    return useSWRMutation(
        OUTBOUNDS_KEY,
        (_key: string, { arg }: { arg: OutboundRequest }) => createOutbound(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const updateOutbound = async (outboundId: number, payload: OutboundRequest) => {
    return request.post<Outbound>(`${OUTBOUNDS_KEY}/${outboundId}`, toOutboundPayload(payload));
};

export const useUpdateOutbound = () => {
    const { mutate } = useSWRConfig();

    return useSWRMutation(
        OUTBOUNDS_KEY,
        (_key: string, { arg }: { arg: { id: number; changes: OutboundRequest } }) =>
            updateOutbound(arg.id, arg.changes),
        {
            throwOnError: false,
            // Renaming also updates references in the base document and other
            // objects. Refresh them before a later edit can post an old tag.
            onSuccess: () =>
                Promise.all([
                    mutate(OUTBOUNDS_KEY),
                    mutate(CONFIG_BASE_KEY),
                    mutate(CONFIG_KEY),
                    mutate(INBOUNDS_KEY),
                ]),
        },
    );
};

// The API answers a deletion with nothing of its own, and a call that was
// refused answers with nothing either, so read straight back the two would be
// the same. The route out that was taken away is what this answers with instead,
// which is something a caller can tell one from the other by.
export const deleteOutbound = async (outboundId: number) => {
    await request.delete(`${OUTBOUNDS_KEY}/${outboundId}`);

    return outboundId;
};

export const useDeleteOutbound = () => {
    const revalidate = useRevalidateOutbounds();

    return useSWRMutation(
        OUTBOUNDS_KEY,
        (_key: string, { arg }: { arg: number }) => deleteOutbound(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

// The types that decide an outcome on the node rather than sending the traffic
// anywhere: `direct` lets it out as it is, `block` drops it. Everything else
// hands it to another server, which is what the address below belongs to.
const TERMINAL_TYPES = new Set(["direct", "block"]);

export const isTerminal = (outbound: Outbound) => TERMINAL_TYPES.has(outbound.type);

// Whether a route out wraps what it sends in TLS, read off the block the core
// takes for it. One with the block switched off is not the same as one that was
// never given a block, so the two are told apart.
export const tlsState = (outbound: Outbound): "enabled" | "disabled" | "none" => {
    if (!isPlainObject(outbound.tls)) {
        return "none";
    }

    return outbound.tls.enabled === true ? "enabled" : "disabled";
};

// Where an outbound sends traffic, for the types that send it somewhere. Server
// and port are options the core accepts rather than fields of their own -- a
// WireGuard route's are its peer's -- so they are read off the record rather than
// typed, and each is null where there is nothing readable to show. A stray server
// left on a type that sends nothing anywhere is not shown as though it routed
// there.
export const destination = (outbound: Outbound) => {
    if (isTerminal(outbound)) {
        return { server: null, port: null };
    }

    return serverOf(outbound.type, outbound);
};
