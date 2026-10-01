// Rules as the proxy core writes them, for routing and for DNS alike: an object
// of conditions a query or a connection is matched on, and of keys that say what
// is done with it once it matches. The two kinds differ in what can be done, not
// in how a rule is shaped, so what reads one reads the other.
export type CoreRule = Record<string, unknown>;

// Whether a rule matches on its own conditions or combines other rules, the way
// the reference names the two.
export const ruleKind = (rule: CoreRule) =>
    rule.type === "logical" ? `Logical (${String(rule.mode ?? "and")})` : "Simple";

// How many conditions a rule matches on: the rules it combines, for a logical
// one, and otherwise the keys it carries that are not about what it does.
export const conditionCount = (rule: CoreRule, actionKeys: ReadonlySet<string>) =>
    rule.type === "logical"
        ? Array.isArray(rule.rules)
            ? rule.rules.length
            : 0
        : Object.keys(rule).filter((key) => !actionKeys.has(key)).length;

// Which of the two a rule is, for what its dialog offers to match on.
export type RuleKind = "route" | "dns";

// What a rule matches on, in the groups the reference's menu switches on and
// off. A group is on while any of its keys is in the rule; switched on, it
// starts where the reference starts it, and switched off, its keys leave the
// rule. A group of several keys is one of them at a time, chosen from a list.
export type ConditionGroup =
    | "inbound"
    | "client"
    | "ipVersion"
    | "network"
    | "protocol"
    | "domain"
    | "port"
    | "sourceIp"
    | "sourcePort"
    | "preferredBy"
    | "interface"
    | "ruleSet";

export const CONDITION_LABELS: Record<ConditionGroup, string> = {
    inbound: "Inbounds",
    client: "Clients",
    ipVersion: "IP version",
    network: "Network",
    protocol: "Protocol",
    domain: "Domain/IP",
    port: "Port",
    sourceIp: "Source IP",
    sourcePort: "Source port",
    preferredBy: "Preferred by (outbound)",
    interface: "Interface address",
    ruleSet: "Rule sets",
};

// The groups each kind of rule offers, in the reference's order. A DNS rule
// matches on fewer of them than a route rule does.
export const CONDITION_GROUPS: Record<RuleKind, ConditionGroup[]> = {
    route: [
        "inbound",
        "client",
        "ipVersion",
        "network",
        "protocol",
        "domain",
        "port",
        "sourceIp",
        "sourcePort",
        "preferredBy",
        "interface",
        "ruleSet",
    ],
    dns: [
        "inbound",
        "client",
        "ipVersion",
        "protocol",
        "domain",
        "port",
        "sourceIp",
        "sourcePort",
        "ruleSet",
    ],
};

const CONDITION_KEYS: Record<ConditionGroup, string[]> = {
    inbound: ["inbound"],
    client: ["auth_user"],
    ipVersion: ["ip_version"],
    network: ["network"],
    protocol: ["protocol"],
    domain: [
        "domain",
        "domain_suffix",
        "domain_keyword",
        "domain_regex",
        "ip_cidr",
        "ip_is_private",
    ],
    port: ["port", "port_range"],
    sourceIp: ["source_ip_cidr", "source_ip_is_private"],
    sourcePort: ["source_port", "source_port_range"],
    preferredBy: ["preferred_by"],
    interface: ["interface_address", "network_interface_address", "default_interface_address"],
    ruleSet: ["rule_set", "rule_set_ip_cidr_match_source"],
};

// The keys a group of several chooses between, where a kind offers fewer: a DNS
// rule matches a name, not an address.
export const conditionChoices = (group: ConditionGroup, kind: RuleKind) =>
    kind === "dns" && group === "domain"
        ? CONDITION_KEYS.domain.slice(0, 4)
        : CONDITION_KEYS[group];

// What each key is called, as the reference calls it.
export const CONDITION_KEY_LABELS: Record<string, string> = {
    domain: "Domains",
    domain_suffix: "Domain suffixes",
    domain_keyword: "Domain keywords",
    domain_regex: "Domain regexes",
    ip_cidr: "IP CIDRs",
    ip_is_private: "Private IP ranges",
    port: "Ports",
    port_range: "Port ranges",
    source_ip_cidr: "Source IP CIDRs",
    source_ip_is_private: "Private source IPs",
    source_port: "Source ports",
    source_port_range: "Source port ranges",
    interface_address: "Interface address",
    network_interface_address: "Network interface address",
    default_interface_address: "Default interface address",
};

// Each key whose value is on or off rather than a list.
export const isSwitchKey = (key: string) => key.endsWith("_is_private");

// Each key whose list is of numbers rather than of text.
export const isNumberListKey = (key: string) => key === "port" || key === "source_port";

const omit = (rule: CoreRule, keys: string[]) =>
    Object.fromEntries(Object.entries(rule).filter(([key]) => !keys.includes(key)));

export const hasCondition = (rule: CoreRule, group: ConditionGroup) =>
    CONDITION_KEYS[group].some((key) => rule[key] !== undefined);

export const withCondition = (
    rule: CoreRule,
    group: ConditionGroup,
    isOn: boolean,
    kind: RuleKind,
): CoreRule => {
    const rest = omit(rule, CONDITION_KEYS[group]);

    if (!isOn) {
        return rest;
    }

    const start: Record<ConditionGroup, CoreRule> = {
        inbound: { inbound: [] },
        client: { auth_user: [] },
        ipVersion: { ip_version: 4 },
        network: { network: [] },
        protocol: { protocol: ["http"] },
        domain: { domain: [] },
        port: { port: [] },
        sourceIp: { source_ip_cidr: [] },
        sourcePort: { source_port: [] },
        preferredBy: { preferred_by: [] },
        interface: { interface_address: [] },
        // A DNS rule has no addresses of its own to match a rule set's against.
        ruleSet:
            kind === "dns"
                ? { rule_set: [] }
                : { rule_set: [], rule_set_ip_cidr_match_source: false },
    };

    return { ...rest, ...start[group] };
};

// The key a group of several is matching on: the one the rule carries, or the
// first while it carries none.
export const conditionKey = (rule: CoreRule, group: ConditionGroup) =>
    CONDITION_KEYS[group].find((key) => rule[key] !== undefined) ?? CONDITION_KEYS[group][0];

// Another key chosen for a group of several: the one before goes, and the new
// one starts empty.
export const withConditionKey = (rule: CoreRule, group: ConditionGroup, key: string) => ({
    ...omit(rule, CONDITION_KEYS[group]),
    [key]: isSwitchKey(key) ? false : [],
});

// The entries typed for a key, read as numbers where the core takes numbers and
// left out where they are not one.
export const listFor = (key: string, entries: string[]) =>
    isNumberListKey(key)
        ? entries.map((entry) => Number.parseInt(entry, 10)).filter((port) => !Number.isNaN(port))
        : entries;

// A rule as its dialog edits it: whether it combines other rules and how, what
// it -- or each rule it combines -- matches, what it does, and whatever else a
// rule that combines others carries beside them.
export interface RuleDraft {
    logical: boolean;
    mode: string;
    rules: CoreRule[];
    action: CoreRule;
    rest: CoreRule;
}

const isObject = (value: unknown): value is CoreRule =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const pickKeys = (rule: CoreRule, keys: ReadonlySet<string>) =>
    Object.fromEntries(Object.entries(rule).filter(([key]) => keys.has(key)));

const omitKeys = (rule: CoreRule, keys: ReadonlySet<string>) =>
    Object.fromEntries(Object.entries(rule).filter(([key]) => !keys.has(key)));

// A rule read into its draft. `actionKeys` are the keys of the kind of rule that
// say what it does rather than what it matches.
export const draftOf = (rule: CoreRule, actionKeys: ReadonlySet<string>): RuleDraft =>
    rule.type === "logical"
        ? {
              logical: true,
              mode: typeof rule.mode === "string" ? rule.mode : "and",
              rules:
                  Array.isArray(rule.rules) && rule.rules.length
                      ? rule.rules.filter(isObject)
                      : [{}],
              action: pickKeys(rule, actionKeys),
              rest: omitKeys(rule, new Set([...actionKeys, "type", "mode", "rules"])),
          }
        : {
              logical: false,
              mode: "and",
              rules: [omitKeys(rule, actionKeys)],
              action: pickKeys(rule, actionKeys),
              rest: {},
          };

const isEmpty = (value: unknown) =>
    value === undefined ||
    value === "" ||
    value === 0 ||
    value === false ||
    (Array.isArray(value) && value.length === 0);

// A draft written back as the rule it is. `actionFields` are the keys each
// action writes, as the reference writes them: the rest are let go, so a rule
// switched from one action to another does not keep what it no longer takes,
// and so is one left empty rather than written as nothing.
export const ruleOf = (
    { logical, mode, rules, action, rest }: RuleDraft,
    actionFields: Record<string, string[]>,
): CoreRule => {
    const name = typeof action.action === "string" ? action.action : "route";
    const does = {
        action: name,
        ...(action.invert === true ? { invert: true } : {}),
        ...Object.fromEntries(
            (actionFields[name] ?? [])
                .filter((key) => !isEmpty(action[key]))
                .map((key) => [key, action[key]]),
        ),
    };

    return logical ? { ...rest, type: "logical", mode, rules, ...does } : { ...rules[0], ...does };
};

// A rule moved from one place in the order to another, which is how the core
// reads them: the first that matches decides.
export const moveRule = <Rule>(rules: Rule[], from: number, to: number) => {
    const moved = [...rules];
    const [rule] = moved.splice(from, 1);

    moved.splice(to, 0, rule);

    return moved;
};

// A rule has nothing of its own a list can know it by across a change -- it has
// no name at all -- and neither does anything else a document written by hand
// can give two of under one tag. So each is given a number, held against the
// object itself. It follows the object when the order changes and goes with it
// when it is deleted, which a place in the list would not: the card after a
// deleted one would take over whatever the deleted one was in the middle of
// asking.
const keys = new WeakMap<object, number>();
let nextKey = 0;

export const keyOf = (object: object) => {
    let key = keys.get(object);

    if (key === undefined) {
        key = nextKey++;
        keys.set(object, key);
    }

    return key;
};
