// How the proxy core dials a connection out, as every object that dials one
// carries it -- a route out, and a DNS server -- among its own options: a detour,
// what it binds to, the socket options and how long it waits. The reference edits
// them in one block wherever they are, so what reads and writes them is written
// once here.
//
// They are switched on and off in the groups the reference offers them in. A
// group is on while its keys are in the options; switched on, it starts where
// the reference starts it, and switched off, its keys leave the options.
export type DialOption =
    | "detour"
    | "bindInterface"
    | "inet4"
    | "inet6"
    | "bindNoPort"
    | "routingMark"
    | "reuseAddr"
    | "tcp"
    | "udp"
    | "connectTimeout"
    | "keepAlive"
    | "domainResolver";

const DIAL_OPTION_KEYS: Record<DialOption, string[]> = {
    detour: ["detour"],
    bindInterface: ["bind_interface"],
    inet4: ["inet4_bind_address"],
    inet6: ["inet6_bind_address"],
    bindNoPort: ["bind_address_no_port"],
    routingMark: ["routing_mark"],
    reuseAddr: ["reuse_addr"],
    tcp: ["tcp_fast_open", "tcp_multi_path"],
    udp: ["udp_fragment"],
    connectTimeout: ["connect_timeout"],
    keepAlive: ["disable_tcp_keep_alive", "tcp_keep_alive", "tcp_keep_alive_interval"],
    domainResolver: ["domain_resolver"],
};

// Every key a group sets, for keeping them when the rest of an object's options
// are let go.
export const DIAL_KEYS = Object.values(DIAL_OPTION_KEYS).flat();

export const DIAL_OPTIONS: { option: DialOption; label: string }[] = [
    { option: "detour", label: "Detour" },
    { option: "bindInterface", label: "Bind to network interface" },
    { option: "inet4", label: "Bind to IPv4" },
    { option: "inet6", label: "Bind to IPv6" },
    { option: "bindNoPort", label: "Bind address no port" },
    { option: "routingMark", label: "Routing mark" },
    { option: "reuseAddr", label: "Reuse listener address" },
    { option: "tcp", label: "TCP options" },
    { option: "udp", label: "UDP options" },
    { option: "connectTimeout", label: "Connection timeout" },
    { option: "keepAlive", label: "TCP keep alive" },
    { option: "domainResolver", label: "Domain resolver" },
];

export const hasDialOption = (options: Record<string, unknown>, option: DialOption) => {
    const present = DIAL_OPTION_KEYS[option].map((key) => options[key] !== undefined);

    // Keep-alive is on with any of its keys, the way the reference reads it; the
    // others only with all of theirs.
    return option === "keepAlive" ? present.some(Boolean) : present.every(Boolean);
};

// Where the two groups that name something else start: a detour at the first
// other route out there is, a domain resolver at the first DNS server.
export interface DialStarts {
    detour?: string;
    domainResolver?: string;
}

export const withDialOption = (
    options: Record<string, unknown>,
    option: DialOption,
    isOn: boolean,
    starts: DialStarts = {},
): Record<string, unknown> => {
    const rest = Object.fromEntries(
        Object.entries(options).filter(([key]) => !DIAL_OPTION_KEYS[option].includes(key)),
    );

    if (!isOn) {
        return rest;
    }

    const start: Record<DialOption, Record<string, unknown>> = {
        detour: { detour: starts.detour ?? "" },
        bindInterface: { bind_interface: "" },
        inet4: { inet4_bind_address: "" },
        inet6: { inet6_bind_address: "" },
        bindNoPort: { bind_address_no_port: true },
        routingMark: { routing_mark: 0 },
        reuseAddr: { reuse_addr: true },
        tcp: { tcp_fast_open: false, tcp_multi_path: false },
        udp: { udp_fragment: true },
        connectTimeout: { connect_timeout: "5s" },
        keepAlive: { tcp_keep_alive: "5m", tcp_keep_alive_interval: "75s" },
        domainResolver: { domain_resolver: starts.domainResolver ?? "" },
    };

    return { ...rest, ...start[option] };
};

// How long a dial may take, in seconds, as the core writes it -- "5s". Null for
// a value in any other shape.
export const timeoutSeconds = (timeout: unknown) => {
    const seconds = typeof timeout === "string" ? /^(\d+)s$/.exec(timeout) : null;

    return seconds ? Number(seconds[1]) : null;
};
