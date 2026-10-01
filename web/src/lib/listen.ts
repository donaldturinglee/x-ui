// What the proxy core does with a connection it accepts beyond where it accepts
// it, as a listener carries it among its own options: a detour, the socket
// options and keep-alive. The reference edits them in one block, so what reads
// and writes them is written once here, beside the block in `src/components`.
//
// They are switched on and off in the groups the reference offers them in. A
// group is on while its keys are in the options; switched on, it starts where
// the reference starts it, and switched off, its keys leave the options.
export type ListenOption = "detour" | "tcp" | "udp" | "keepAlive";

const LISTEN_OPTION_KEYS: Record<ListenOption, string[]> = {
    detour: ["detour"],
    tcp: ["tcp_fast_open", "tcp_multi_path"],
    udp: ["udp_fragment", "udp_timeout"],
    keepAlive: ["disable_tcp_keep_alive", "tcp_keep_alive", "tcp_keep_alive_interval"],
};

// Every key a group sets, for keeping them when the rest of an object's options
// are let go.
export const LISTEN_KEYS = Object.values(LISTEN_OPTION_KEYS).flat();

export const LISTEN_OPTIONS: { option: ListenOption; label: string }[] = [
    { option: "detour", label: "Detour" },
    { option: "tcp", label: "TCP options" },
    { option: "udp", label: "UDP options" },
    { option: "keepAlive", label: "TCP keep alive" },
];

export const hasListenOption = (options: Record<string, unknown>, option: ListenOption) => {
    const present = LISTEN_OPTION_KEYS[option].map((key) => options[key] !== undefined);

    // Keep-alive is on with any of its keys, the way the reference reads it; the
    // others only with all of theirs.
    return option === "keepAlive" ? present.some(Boolean) : present.every(Boolean);
};

// A detour starts at `detour`, which is the first listener there is to forward
// to.
export const withListenOption = (
    options: Record<string, unknown>,
    option: ListenOption,
    isOn: boolean,
    detour = "",
): Record<string, unknown> => {
    const rest = Object.fromEntries(
        Object.entries(options).filter(([key]) => !LISTEN_OPTION_KEYS[option].includes(key)),
    );

    if (!isOn) {
        return rest;
    }

    const start = {
        detour: { detour },
        tcp: { tcp_fast_open: false, tcp_multi_path: false },
        udp: { udp_fragment: false, udp_timeout: "5m" },
        keepAlive: { tcp_keep_alive: "5m", tcp_keep_alive_interval: "75s" },
    }[option];

    return { ...rest, ...start };
};

// Every group switched off, for something that binds nothing to have them on.
export const withoutListenOptions = (options: Record<string, unknown>) =>
    LISTEN_OPTIONS.reduce((rest, { option }) => withListenOption(rest, option, false), options);

// How long the core keeps a UDP mapping, in minutes, as it writes it -- "5m".
// Null for a value in any other shape.
export const udpTimeoutMinutes = (timeout: unknown) => {
    const minutes = typeof timeout === "string" ? /^(\d+)m$/.exec(timeout) : null;

    return minutes ? Number(minutes[1]) : null;
};
