import { z } from "zod";

import type { CoreConfig } from "@/features/config/api";
import { conditionCount, draftOf, ruleOf, type CoreRule, type RuleDraft } from "@/lib/rules";

export { moveRule, ruleKind, type RuleDraft } from "@/lib/rules";

// Where a node sends a connection, as the proxy core reads it from the `route`
// key of the base document: the rules it is matched against in order, the rule
// sets they can name, and what happens to one no rule matched. Like DNS, it has
// no table of its own; this is a way of editing one key of that document.
//
// Only what the page shows has a name here. Anything else the core accepts under
// `route` is carried through an edit untouched.
export interface Route {
    rules?: RouteRule[];
    rule_set?: RuleSet[];
    final?: string;
    // A DNS server's tag, or an object naming one with options of its own.
    default_domain_resolver?: unknown;
    default_interface?: string;
    default_mark?: number;
    default_http_client?: string;
    auto_detect_interface?: boolean;
    [option: string]: unknown;
}

// A rule a connection is matched against. Its conditions are whatever the core
// accepts, so it is held as the object it is.
export type RouteRule = CoreRule;

// A list of conditions kept apart from the rules that name it by its tag: a file
// on the node, one downloaded and kept up to date, or rules written inline.
export interface RuleSet {
    type: string;
    tag: string;
    format?: string;
    [option: string]: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// The section as the document holds it, with its lists read as lists whatever
// the document says, so a page built on them has something to map over.
export const routeOf = (config: CoreConfig | undefined): Route => {
    const route = isPlainObject(config?.route) ? (config.route as Route) : {};

    return {
        ...route,
        rules: Array.isArray(route.rules) ? route.rules : [],
        rule_set: Array.isArray(route.rule_set) ? route.rule_set : [],
    };
};

// The document with its route section replaced and every other key left as it
// was read. An option cleared on the page is left out rather than written empty.
export const withRoute = (config: CoreConfig, route: Route): CoreConfig => ({
    ...config,
    route: Object.fromEntries(
        Object.entries(route).filter(([, value]) => value !== undefined && value !== ""),
    ),
});

// Whether what is on the page differs from what the document holds.
export const isRouteChanged = (config: CoreConfig | undefined, route: Route) =>
    JSON.stringify(routeOf(config)) !== JSON.stringify(routeOf(withRoute(config ?? {}, route)));

// The DNS server that resolves the names outbounds dial, by its tag. One written
// as an object with options of its own is read by the server it names, and kept
// as it is written until another is chosen.
export const resolverOf = (route: Route) => {
    const resolver = route.default_domain_resolver;

    if (typeof resolver === "string") {
        return resolver;
    }

    return isPlainObject(resolver) && typeof resolver.server === "string" ? resolver.server : "";
};

// What a rule can do with a connection it matches, by the names the reference
// gives them and in its order.
export const RULE_ACTIONS = [
    { value: "route", label: "Route" },
    { value: "route-options", label: "Route options" },
    { value: "bypass", label: "Bypass" },
    { value: "reject", label: "Reject" },
    { value: "hijack-dns", label: "Hijack DNS" },
    { value: "sniff", label: "Sniff" },
    { value: "resolve", label: "Resolve" },
];

// What the core can sniff for, and how a name can be resolved, by the names the
// reference gives them.
export const SNIFFERS = [
    { value: "http", label: "HTTP" },
    { value: "tls", label: "TLS" },
    { value: "quic", label: "QUIC" },
    { value: "stun", label: "STUN" },
    { value: "dns", label: "DNS" },
    { value: "bittorrent", label: "BitTorrent" },
    { value: "dtls", label: "DTLS" },
    { value: "ssh", label: "SSH" },
    { value: "rdp", label: "RDP" },
    { value: "ntp", label: "NTP" },
];

export const RESOLVE_STRATEGIES = [
    { value: "prefer_ipv4", label: "Prefer IPv4" },
    { value: "prefer_ipv6", label: "Prefer IPv6" },
    { value: "ipv4_only", label: "IPv4 only" },
    { value: "ipv6_only", label: "IPv6 only" },
];

// The keys of a rule that say what it does rather than what it matches, which is
// what a count of its conditions leaves out.
const ACTION_KEYS = new Set([
    "invert",
    "action",
    "outbound",
    "override_address",
    "override_port",
    "udp_disable_domain_unmapping",
    "udp_connect",
    "udp_timeout",
    "method",
    "no_drop",
    "sniffer",
    "timeout",
    "strategy",
    "server",
]);

// How many conditions a rule matches on, which the card says under "Rules".
export const ruleConditions = (rule: RouteRule) => conditionCount(rule, ACTION_KEYS);

// The kinds of rule set, by the names the reference gives them.
export const RULE_SET_TYPES = [
    { value: "local", name: "Local" },
    { value: "remote", name: "Remote" },
    { value: "inline", name: "Inline" },
];

export const ruleSetTypeName = (type: string) =>
    RULE_SET_TYPES.find((known) => known.value === type)?.name ?? type;

export const RULE_SET_FORMATS = ["binary", "source"];

// Which route out a remote rule set is downloaded through, where it names one of
// its own rather than a shared client or none at all.
export const downloadDetour = (ruleSet: RuleSet) => {
    const client = ruleSet.http_client;

    return isPlainObject(client) && typeof client.detour === "string" && client.detour
        ? client.detour
        : null;
};

// Reads a document of options, or null when it is not a JSON object.
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
const toDocument = (value: Record<string, unknown>, named: ReadonlySet<string>) => {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !named.has(key)));

    return Object.keys(rest).length ? JSON.stringify(rest, null, 4) : "";
};

const withoutNamed = (value: Record<string, unknown>, named: ReadonlySet<string>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !named.has(key)));

const RULE_SET_FIELDS = new Set(["type", "tag", "format"]);

export const ruleSetRequest = z.object({
    type: z.string().min(1, "Choose a type."),
    // What a rule names it by.
    tag: z
        .string()
        .min(1, "Enter a tag.")
        .max(64, "Use 64 characters or fewer.")
        .regex(/^\S+$/, "Use no spaces."),
    // Empty for an inline one, whose rules are written in the document itself.
    format: z.string(),
    options: z.string().refine(isDocument, "Use a JSON object, or leave it empty."),
});

export type RuleSetRequest = z.infer<typeof ruleSetRequest>;

export const fromRuleSet = (ruleSet: RuleSet): RuleSetRequest => ({
    type: ruleSet.type,
    tag: ruleSet.tag,
    format: typeof ruleSet.format === "string" ? ruleSet.format : "",
    options: toDocument(ruleSet, RULE_SET_FIELDS),
});

// The named fields win over the same keys typed into the options, and a format
// is only written for a rule set that has one.
export const toRuleSet = ({ options, type, tag, format }: RuleSetRequest): RuleSet => ({
    type,
    tag,
    ...(format ? { format } : {}),
    ...withoutNamed(parseDocument(options) ?? {}, RULE_SET_FIELDS),
});

// A new rule as the reference starts one: matching everything, and routing it
// to the first route out.
export const newRuleDraft = (outbound: string): RuleDraft => ({
    logical: false,
    mode: "and",
    rules: [{}],
    action: { action: "route", outbound },
    rest: {},
});

export const toRuleDraft = (rule: RouteRule) => draftOf(rule, ACTION_KEYS);

// The keys each action writes, as the reference writes them.
const ACTION_FIELDS: Record<string, string[]> = {
    route: ["outbound"],
    "route-options": [
        "override_address",
        "override_port",
        "network_strategy",
        "fallback_delay",
        "udp_disable_domain_unmapping",
        "udp_connect",
        "udp_timeout",
    ],
    reject: ["method", "no_drop"],
    sniff: ["sniffer", "timeout"],
    resolve: ["strategy", "server"],
};

export const fromRuleDraft = (draft: RuleDraft): RouteRule => ruleOf(draft, ACTION_FIELDS);

// What is taken from a pasted configuration: its route section, or a bare object
// carrying the same lists.
export interface ImportedRoute {
    rules: RouteRule[];
    rule_set: RuleSet[];
    final?: string;
}

export const readRouteBlock = (document: string): ImportedRoute | null => {
    const parsed = parseDocument(document);

    if (!parsed) {
        return null;
    }

    const block = isPlainObject(parsed.route) ? parsed.route : parsed;
    const rules = Array.isArray(block.rules) ? block.rules.filter(isPlainObject) : null;
    const ruleSets = Array.isArray(block.rule_set)
        ? block.rule_set.filter(
              (ruleSet): ruleSet is RuleSet =>
                  isPlainObject(ruleSet) && typeof ruleSet.tag === "string",
          )
        : null;

    if (!rules && !ruleSets) {
        return null;
    }

    return {
        rules: rules ?? [],
        rule_set: ruleSets ?? [],
        ...(typeof block.final === "string" && block.final ? { final: block.final } : {}),
    };
};

// Takes an imported block onto the page's own: in place of what is there, or
// after it, where a rule set under a tag already taken is left out rather than
// written twice.
export const importRoute = (
    route: Route,
    block: ImportedRoute,
    mode: "merge" | "replace",
    takeFinal: boolean,
): Route => {
    const rules = route.rules ?? [];
    const ruleSets = route.rule_set ?? [];
    const taken = new Set(ruleSets.map((ruleSet) => ruleSet.tag));

    return {
        ...route,
        rules: mode === "replace" ? block.rules : [...rules, ...block.rules],
        rule_set:
            mode === "replace"
                ? block.rule_set
                : [...ruleSets, ...block.rule_set.filter((ruleSet) => !taken.has(ruleSet.tag))],
        ...(takeFinal && block.final ? { final: block.final } : {}),
    };
};

// The tag a rule set downloaded from an address is given: the name of the file
// it points at, without its extension.
export const tagFromUrl = (url: string) => {
    let path = url;

    try {
        path = new URL(url).pathname;
    } catch {
        // Not an address the browser can read, so it is split as it stands.
    }

    const file = path.split("/").pop() ?? "";

    return file.replace(/\.[^.]+$/, "") || url;
};

// The addresses in a pasted list, one to a line, each only once.
export const readUrls = (text: string) => [
    ...new Set(
        text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("http")),
    ),
];

// A route out the core would refuse as a detour: a direct one with nothing set
// on it dials exactly what no detour dials, so it is written as none.
export const isPlainDirect = (outbound: Record<string, unknown> | undefined) =>
    outbound !== undefined &&
    outbound.type === "direct" &&
    Object.keys(outbound).every((key) => ["id", "type", "tag"].includes(key));

interface RemoteRuleSet {
    tag: string;
    url: string;
    format: string;
    // The route out it is downloaded through, if it names one.
    detour?: string;
    // How many days it is kept before it is downloaded again, none for never.
    days: number;
}

export const remoteRuleSet = ({ tag, url, format, detour, days }: RemoteRuleSet): RuleSet => ({
    type: "remote",
    tag,
    format,
    url,
    ...(detour ? { http_client: { detour } } : {}),
    ...(days > 0 ? { update_interval: `${days}d` } : {}),
});

const srs = (kind: "geosite" | "geoip", name: string) =>
    `https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/${kind}/${name}.srs`;

// The rule sets the reference offers ready-made, by the names it gives them: the
// sites and addresses most often routed on their own.
export const RULE_SET_CATALOG = [
    { tag: "geosite-private", name: "Site-Private", url: srs("geosite", "private") },
    { tag: "geoip-private", name: "IP-Private", url: srs("geoip", "private") },
    { tag: "geosite-ads", name: "Site-Ads", url: srs("geosite", "category-ads-all") },
    { tag: "geosite-ir", name: "Site-Iran", url: srs("geosite", "category-ir") },
    { tag: "geoip-ir", name: "IP-Iran", url: srs("geoip", "ir") },
    { tag: "geosite-cn", name: "Site-China", url: srs("geosite", "cn") },
    { tag: "geoip-cn", name: "IP-China", url: srs("geoip", "cn") },
    {
        tag: "geosite-vn",
        name: "Site-Vietnam",
        url: "https://github.com/Thaomtam/Geosite-vn/raw/rule-set/Geosite-vn.srs",
    },
    { tag: "geoip-vn", name: "IP-Vietnam", url: srs("geoip", "vn") },
    { tag: "geosite-google", name: "Site-Google", url: srs("geosite", "google") },
    { tag: "geoip-google", name: "IP-Google", url: srs("geoip", "google") },
    { tag: "geosite-google-play", name: "Site-GooglePlay", url: srs("geosite", "google-play") },
    { tag: "geosite-youtube", name: "Site-YouTube", url: srs("geosite", "youtube") },
    { tag: "geosite-twitter", name: "Site-Twitter/X", url: srs("geosite", "twitter") },
    { tag: "geoip-twitter", name: "IP-Twitter/X", url: srs("geoip", "twitter") },
    { tag: "geosite-telegram", name: "Site-Telegram", url: srs("geosite", "telegram") },
    { tag: "geoip-telegram", name: "IP-Telegram", url: srs("geoip", "telegram") },
    { tag: "geosite-netflix", name: "Site-Netflix", url: srs("geosite", "netflix") },
    { tag: "geoip-netflix", name: "IP-Netflix", url: srs("geoip", "netflix") },
    { tag: "geosite-openai", name: "Site-OpenAI", url: srs("geosite", "openai") },
    { tag: "geosite-reddit", name: "Site-Reddit", url: srs("geosite", "reddit") },
];
