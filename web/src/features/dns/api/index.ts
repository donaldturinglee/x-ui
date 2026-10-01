import { z } from "zod";

import type { CoreConfig } from "@/features/config/api";
import { DIAL_KEYS } from "@/lib/dial";
import { conditionCount, draftOf, ruleOf, type CoreRule, type RuleDraft } from "@/lib/rules";

export { moveRule, ruleKind } from "@/lib/rules";

// How a node resolves names, as the proxy core reads it from the `dns` key of the
// base document. There is no table of its own: it is part of that document, read
// and written with the rest of it, so this is a way of editing one key of it
// rather than a resource the API knows about.
//
// Only what the page shows has a name here. Anything else the core accepts under
// `dns` is carried through an edit untouched.
export interface Dns {
    servers?: DnsServer[];
    rules?: DnsRule[];
    final?: string;
    strategy?: string;
    client_subnet?: string;
    cache_capacity?: number;
    disable_cache?: boolean;
    disable_expire?: boolean;
    reverse_mapping?: boolean;
    [option: string]: unknown;
}

// A server a node can ask. The tag is what a rule names it by and the type is
// the protocol it is asked over; everything else is an option the core accepts
// for that type.
export interface DnsServer {
    type: string;
    tag: string;
    [option: string]: unknown;
}

// A rule the core matches a query against, in order, to decide which server
// answers it. Its conditions are whatever the core accepts, so it is held as the
// object it is.
export type DnsRule = CoreRule;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// The section as the document holds it, or an empty one for a document that has
// none yet. The lists are read as lists whatever the document says, so a page
// built on them has something to map over.
export const dnsOf = (config: CoreConfig | undefined): Dns => {
    const dns = isPlainObject(config?.dns) ? (config.dns as Dns) : {};

    return {
        ...dns,
        servers: Array.isArray(dns.servers) ? dns.servers : [],
        rules: Array.isArray(dns.rules) ? dns.rules : [],
    };
};

// The document with its DNS section replaced, and every other key it holds left
// as it was read. An option cleared on the page is left out rather than written
// as an empty value, which the core would read as one that was set.
export const withDns = (config: CoreConfig, dns: Dns): CoreConfig => ({
    ...config,
    dns: Object.fromEntries(
        Object.entries(dns).filter(([, value]) => value !== undefined && value !== ""),
    ),
});

// Whether what is on the page differs from what the document holds, which is
// what the save button waits on.
export const isDnsChanged = (config: CoreConfig | undefined, dns: Dns) =>
    JSON.stringify(dnsOf(config)) !== JSON.stringify(dnsOf(withDns(config ?? {}, dns)));

// How the core prefers to resolve a name that has both kinds of address.
export const DNS_STRATEGIES = ["prefer_ipv4", "prefer_ipv6", "ipv4_only", "ipv6_only"];

// The server types the proxy core accepts, as the reference offers them and in
// its order. Offered as a list for the same reason a listener's are: a
// misspelled type is a node that will not start. One from a newer core is still
// kept on an edit.
//
// The reference also offers a Tailscale server and a resolved one, which are
// answered through a Tailscale endpoint and a resolved service. The panel keeps
// neither -- no endpoints but the WireGuard routes out, and no services -- so
// there is nothing for one to name, and they are not offered; one written
// elsewhere is kept on an edit as a type the panel does not know is.
export const DNS_SERVER_TYPES = [
    "local",
    "mdns",
    "hosts",
    "tcp",
    "udp",
    "tls",
    "quic",
    "https",
    "h3",
    "dhcp",
    "fakeip",
];

// What each type is asked with, as the reference sorts them: the ones asked at
// an address of their own; of those, the ones asked over HTTP at a path, and
// every one asked over TLS -- which is what a server of the type has beyond the
// fields the panel gives it. The rest dial out, bar the ones answered on the
// node or through something else.
const ADDRESSED_TYPES = new Set(["tcp", "udp", "tls", "quic", "https", "h3"]);
const PATH_TYPES = new Set(["https", "h3"]);
const UNDIALLED_TYPES = new Set(["hosts", "tailscale", "fakeip", "resolved"]);
const OPTIONED_TYPES = new Set(["tls", "quic", "https", "h3"]);

export const isAddressed = (type: string) => ADDRESSED_TYPES.has(type);
export const hasPath = (type: string) => PATH_TYPES.has(type);
export const dnsServerDials = (type: string) => !UNDIALLED_TYPES.has(type);
export const hasOwnDnsOptions = (type: string) => OPTIONED_TYPES.has(type);

// What of a server's options another type keeps: where it is asked and how it
// dials, as far as that type does either. The rest were the old type's own, and
// the new one starts without them, as the reference starts it.
export const dnsServerOptionsForType = (options: Record<string, unknown>, type: string) => {
    const kept = [
        ...(isAddressed(type) ? ["server", "server_port"] : []),
        ...(dnsServerDials(type) ? DIAL_KEYS : []),
    ];

    return Object.fromEntries(Object.entries(options).filter(([key]) => kept.includes(key)));
};

// A name a hosts server answers for itself, as the row the page edits it in:
// the name, and its addresses a comma apart.
export interface Host {
    name: string;
    addresses: string;
}

export const hostsOf = (predefined: unknown): Host[] =>
    isPlainObject(predefined)
        ? Object.entries(predefined).map(([name, addresses]) => ({
              name,
              addresses: Array.isArray(addresses) ? addresses.join(",") : String(addresses ?? ""),
          }))
        : [];

// The rows written back as the option: one with no name yet is left out, as is
// the option once there are none.
export const withHosts = (hosts: Host[]) => {
    const named = hosts.filter((host) => host.name.trim());

    return named.length
        ? Object.fromEntries(
              named.map((host) => [
                  host.name.trim(),
                  host.addresses
                      .split(",")
                      .map((address) => address.trim())
                      .filter(Boolean),
              ]),
          )
        : undefined;
};

// Where the proxy core documents DNS servers and DNS rules, as the mark in a
// dialog's title leads to them.
export const DNS_SERVER_DOCS = {
    href: "https://sing-box.sagernet.org/configuration/dns/server/",
    label: "DNS server",
};

export const DNS_RULE_DOCS = {
    href: "https://sing-box.sagernet.org/configuration/dns/rule/",
    label: "DNS rule",
};

// Where a server is asked. The address and port are options the core accepts
// rather than fields of their own, so they are read off the server rather than
// typed, and each is null where there is nothing readable to show -- which is
// every type that is not asked over the network, local and fakeip among them.
export const serverAddress = (server: DnsServer) => ({
    address: typeof server.server === "string" && server.server ? server.server : null,
    port: typeof server.server_port === "number" ? server.server_port : null,
});

// Whether a server is asked over TLS, read off the block the core takes for it.
// One with the block switched off is not the same as one never given a block,
// so the two are told apart, as they are for a route out.
export const serverTls = (server: DnsServer): "enabled" | "disabled" | "none" => {
    if (!isPlainObject(server.tls)) {
        return "none";
    }

    return server.tls.enabled === true ? "enabled" : "disabled";
};

// What a rule can do with a query it matches, by the names the reference gives
// them.
export const DNS_RULE_ACTIONS = [
    { value: "route", label: "Route" },
    { value: "route-options", label: "Route options" },
    { value: "reject", label: "Reject" },
    { value: "predefined", label: "Predefined" },
];

// The answers a predefined rule can give, by the names the reference gives them.
export const DNS_RCODES = [
    { value: "NOERROR", label: "Ok" },
    { value: "FORMERR", label: "Bad request" },
    { value: "SERVFAIL", label: "Server failure" },
    { value: "NXDOMAIN", label: "Not found" },
    { value: "NOTIMP", label: "Not implemented" },
    { value: "REFUSED", label: "Refused" },
];

// The keys of a rule that say what it does rather than what it matches, which
// is what a count of its conditions leaves out.
const ACTION_KEYS = new Set([
    "invert",
    "action",
    "server",
    "strategy",
    "disable_cache",
    "rewrite_ttl",
    "client_subnet",
    "method",
    "no_drop",
    "rcode",
    "answer",
    "ns",
    "extra",
]);

// How many conditions a rule matches on, which the card says under "Rules".
export const ruleConditions = (rule: DnsRule) => conditionCount(rule, ACTION_KEYS);

// Reads an options document, or null when it is not a JSON object.
export const parseDocument = (document: string): Record<string, unknown> | null => {
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

const isDocument = (document: string) => parseDocument(document) !== null;

// Written as the document an operator edits, with the keys that have fields of
// their own taken out, and nothing at all as empty rather than a pair of braces.
const toDocument = (value: Record<string, unknown>, named: Set<string>) => {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !named.has(key)));

    return Object.keys(rest).length ? JSON.stringify(rest, null, 4) : "";
};

// Options written as the document the form holds, and none as nothing.
export const optionsDocument = (options: Record<string, unknown>) =>
    Object.keys(options).length ? JSON.stringify(options, null, 4) : "";

const SERVER_FIELDS = new Set(["type", "tag"]);

// Writing a server and amending one ask for the same things, held to one shape.
export const dnsServerRequest = z.object({
    type: z
        .string()
        .min(1, "Choose a type.")
        .max(64, "Use 64 characters or fewer.")
        .regex(/^\S+$/, "Use no spaces."),
    // What rules and the final server name it by.
    tag: z
        .string()
        .min(1, "Enter a tag.")
        .max(64, "Use 64 characters or fewer.")
        .regex(/^\S+$/, "Use no spaces."),
    options: z.string().refine(isDocument, "Use a JSON object, or leave it empty."),
});

export type DnsServerRequest = z.infer<typeof dnsServerRequest>;

export const fromDnsServer = (server: DnsServer): DnsServerRequest => ({
    type: server.type,
    tag: server.tag,
    options: toDocument(server, SERVER_FIELDS),
});

// The named fields are spread last, so a key typed into the options cannot
// quietly override the tag or the type that was filled in above it.
export const toDnsServer = ({ options, ...named }: DnsServerRequest): DnsServer => ({
    ...(parseDocument(options) ?? {}),
    ...named,
});

// A new rule as the reference starts one: matching every query, and routing it
// to the first server.
export const newDnsRuleDraft = (server: string): RuleDraft => ({
    logical: false,
    mode: "and",
    rules: [{}],
    action: { action: "route", server },
    rest: {},
});

export const toDnsRuleDraft = (rule: DnsRule) => draftOf(rule, ACTION_KEYS);

// The keys each action writes, as the reference writes them.
const ACTION_FIELDS: Record<string, string[]> = {
    route: ["server", "strategy", "disable_cache", "rewrite_ttl", "client_subnet"],
    "route-options": ["disable_cache", "rewrite_ttl", "client_subnet"],
    reject: ["method", "no_drop"],
    predefined: ["rcode", "answer", "ns", "extra"],
};

// Records to answer with are only an answer that is not an error.
export const fromDnsRuleDraft = (draft: RuleDraft): DnsRule => {
    const rule = ruleOf(draft, ACTION_FIELDS);

    return rule.action === "predefined" && rule.rcode !== "NOERROR"
        ? Object.fromEntries(
              Object.entries(rule).filter(([key]) => !["answer", "ns", "extra"].includes(key)),
          )
        : rule;
};
