// Fields accepted by the sing-box 1.14 outbound configuration. Keep this list
// independent of the form so creation and its validation use the same paths.
// Optional advanced settings on existing routes remain available in Edit's JSON.
export interface OutboundOptionField {
    path: string;
    label: string;
    input?: "text" | "password" | "number" | "select" | "list" | "textarea" | "switch";
    choices?: readonly (string | number)[];
    separator?: "," | "\n";
    required?: boolean;
    when?: (options: Record<string, unknown>) => boolean;
}

export const optionAt = (options: Record<string, unknown>, path: string): unknown =>
    path
        .split(".")
        .reduce<unknown>(
            (value, key) =>
                value && typeof value === "object" && !Array.isArray(value)
                    ? (value as Record<string, unknown>)[key]
                    : undefined,
            options,
        );

export const withOptionAt = (
    options: Record<string, unknown>,
    path: string,
    value: unknown,
): Record<string, unknown> => {
    const [key, ...rest] = path.split(".");
    const next = { ...options };

    if (rest.length) {
        const old = next[key];
        const child = withOptionAt(
            old && typeof old === "object" && !Array.isArray(old)
                ? (old as Record<string, unknown>)
                : {},
            rest.join("."),
            value,
        );
        if (Object.keys(child).length) {
            next[key] = child;
        } else {
            delete next[key];
        }
    } else if (value === undefined || value === "") {
        delete next[key];
    } else {
        next[key] = value;
    }

    return next;
};

const field = (
    path: string,
    label: string,
    extra: Omit<OutboundOptionField, "path" | "label"> = {},
): OutboundOptionField => ({ path, label, ...extra });
const required = (path: string, label: string, input: OutboundOptionField["input"] = "text") =>
    field(path, label, { input, required: true });
const choice = (path: string, label: string, choices: readonly (string | number)[]) =>
    field(path, label, { input: "select", choices });
const network = choice("network", "Network", ["tcp", "udp"]);

export const SHADOWSOCKS_METHODS = [
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "none",
    "aes-128-gcm",
    "aes-192-gcm",
    "aes-256-gcm",
    "chacha20-ietf-poly1305",
    "xchacha20-ietf-poly1305",
    "aes-128-ctr",
    "aes-192-ctr",
    "aes-256-ctr",
    "aes-128-cfb",
    "aes-192-cfb",
    "aes-256-cfb",
    "rc4-md5",
    "chacha20-ietf",
    "xchacha20",
] as const;

export const OUTBOUND_TYPE_FIELDS: Record<string, OutboundOptionField[]> = {
    socks: [
        choice("version", "SOCKS version", ["4", "4a", "5"]),
        field("username", "Username"),
        field("password", "Password", {
            input: "password",
            when: (options) => !options.version || options.version === "5",
        }),
        network,
    ],
    http: [
        field("username", "Username"),
        field("password", "Password", { input: "password" }),
        field("path", "HTTP path"),
    ],
    shadowsocks: [
        field("method", "Encryption method", {
            input: "select",
            choices: SHADOWSOCKS_METHODS,
            required: true,
        }),
        required("password", "Password", "password"),
        choice("plugin", "Plugin", ["obfs-local", "v2ray-plugin"]),
        field("plugin_opts", "Plugin options", { when: (options) => !!options.plugin }),
        network,
    ],
    snell: [
        field("version", "Snell version", { input: "select", choices: [4, 6], required: true }),
        required("psk", "Pre-shared key", "password"),
        field("userkey", "User key", { input: "password" }),
        network,
        field("obfs_mode", "Obfuscation", {
            input: "select",
            choices: ["none", "http"],
            when: (options) => options.version === 4,
        }),
        field("obfs_host", "Obfuscation host", {
            when: (options) => options.version === 4 && options.obfs_mode === "http",
        }),
        field("mode", "Traffic shaping", {
            input: "select",
            choices: ["default", "unshaped", "unsafe-raw"],
            when: (options) => options.version === 6,
        }),
    ],
    vmess: [
        required("uuid", "UUID"),
        choice("security", "Encryption", [
            "auto",
            "none",
            "zero",
            "aes-128-gcm",
            "chacha20-poly1305",
            "aes-128-ctr",
        ]),
        field("alter_id", "Alter ID", { input: "number" }),
        network,
        choice("packet_encoding", "Packet encoding", ["packetaddr", "xudp"]),
    ],
    trojan: [required("password", "Password", "password"), network],
    naive: [
        field("username", "Username"),
        field("password", "Password", { input: "password" }),
        field("quic", "Use QUIC", { input: "switch" }),
    ],
    hysteria: [
        required("up_mbps", "Upload (Mbps)", "number"),
        required("down_mbps", "Download (Mbps)", "number"),
        field("auth_str", "Authentication password", { input: "password" }),
        field("obfs", "Obfuscation password", { input: "password" }),
        network,
    ],
    vless: [
        required("uuid", "UUID"),
        choice("flow", "Flow", ["xtls-rprx-vision"]),
        network,
        choice("packet_encoding", "Packet encoding", ["packetaddr", "xudp"]),
    ],
    shadowtls: [
        choice("version", "ShadowTLS version", [1, 2, 3]),
        field("password", "Password", {
            input: "password",
            required: true,
            when: (options) => options.version === 2 || options.version === 3,
        }),
    ],
    tuic: [
        required("uuid", "UUID"),
        field("password", "Password", { input: "password" }),
        choice("congestion_control", "Congestion control", ["cubic", "new_reno", "bbr"]),
        choice("udp_relay_mode", "UDP relay mode", ["native", "quic"]),
        network,
    ],
    hysteria2: [
        field("password", "Password", { input: "password" }),
        field("up_mbps", "Upload (Mbps)", { input: "number" }),
        field("down_mbps", "Download (Mbps)", { input: "number" }),
        choice("obfs.type", "Obfuscation", ["salamander", "gecko"]),
        field("obfs.password", "Obfuscation password", {
            input: "password",
            required: true,
            when: (options) => !!optionAt(options, "obfs.type"),
        }),
        network,
    ],
    anytls: [required("password", "Password", "password")],
    tor: [
        required("executable_path", "Tor executable path"),
        field("data_directory", "Tor data directory"),
    ],
    ssh: [
        field("user", "SSH user"),
        field("password", "Password", { input: "password" }),
        field("private_key_path", "Private key path"),
        field("private_key", "Private key", { input: "textarea" }),
        field("private_key_passphrase", "Key passphrase", { input: "password" }),
        field("host_key", "Host keys (one per line)", { input: "list", separator: "\n" }),
    ],
    selector: [
        field("outbounds", "Outbound tags (comma separated)", {
            input: "list",
            separator: ",",
            required: true,
        }),
        field("default", "Default outbound tag"),
    ],
    urltest: [
        field("outbounds", "Outbound tags (comma separated)", {
            input: "list",
            separator: ",",
            required: true,
        }),
        field("url", "Test URL"),
        field("interval", "Test interval"),
        field("tolerance", "Tolerance (ms)", { input: "number" }),
    ],
    bridge: [
        field("interface", "Egress interface"),
        field("bridge_name", "Bridge name"),
        field("iproute2_table_index", "Routing table index", { input: "number" }),
        field("iproute2_rule_index", "Routing rule index", { input: "number" }),
    ],
};

export const TLS_REQUIRED_TYPES = new Set([
    "naive",
    "hysteria",
    "shadowtls",
    "tuic",
    "hysteria2",
    "anytls",
]);
export const TLS_OPTIONAL_TYPES = new Set(["http", "vmess", "trojan", "vless"]);
export const TRANSPORT_TYPES = new Set(["vmess", "trojan", "vless"]);

export const TLS_FIELDS: OutboundOptionField[] = [
    field("tls.server_name", "TLS server name"),
    field("tls.insecure", "Allow insecure certificate", { input: "switch" }),
    field("tls.alpn", "ALPN (comma separated)", { input: "list", separator: "," }),
    field("tls.certificate_path", "CA certificate path"),
    field("tls.utls.enabled", "uTLS", { input: "switch" }),
    field("tls.utls.fingerprint", "uTLS fingerprint", {
        when: (options) => optionAt(options, "tls.utls.enabled") === true,
    }),
    field("tls.reality.enabled", "Reality", { input: "switch" }),
    field("tls.reality.public_key", "Reality public key", {
        required: true,
        when: (options) => optionAt(options, "tls.reality.enabled") === true,
    }),
    field("tls.reality.short_id", "Reality short ID", {
        when: (options) => optionAt(options, "tls.reality.enabled") === true,
    }),
];

export const NAIVE_TLS_FIELDS = TLS_FIELDS.filter((entry) =>
    ["tls.server_name", "tls.certificate_path"].includes(entry.path),
);

export const TRANSPORT_FIELDS: OutboundOptionField[] = [
    field("transport.path", "Transport path", {
        when: (options) =>
            ["ws", "http", "httpupgrade"].includes(String(optionAt(options, "transport.type"))),
    }),
    field("transport.headers.Host", "WebSocket Host header", {
        when: (options) => optionAt(options, "transport.type") === "ws",
    }),
    field("transport.host", "HTTP host (comma separated)", {
        input: "list",
        separator: ",",
        when: (options) => optionAt(options, "transport.type") === "http",
    }),
    field("transport.host", "HTTP Upgrade host", {
        when: (options) => optionAt(options, "transport.type") === "httpupgrade",
    }),
    field("transport.service_name", "gRPC service name", {
        when: (options) => optionAt(options, "transport.type") === "grpc",
    }),
];

export interface OutboundOptionIssue {
    path: string;
    message: string;
}

const isFilled = (value: unknown) =>
    typeof value === "string"
        ? value.trim().length > 0
        : typeof value === "number"
          ? Number.isFinite(value)
          : Array.isArray(value)
            ? value.length > 0
            : value !== undefined && value !== null;

const isWireGuardKey = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value);

const isIPPrefix = (value: unknown) => {
    if (typeof value !== "string") {
        return false;
    }
    const parts = value.split("/");
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
        return false;
    }
    const [address, prefix] = parts;
    if (address.includes(":")) {
        try {
            new URL(`http://[${address}]/`);
            return Number(prefix) <= 128;
        } catch {
            return false;
        }
    }
    const octets = address.split(".");
    return (
        Number(prefix) <= 32 &&
        octets.length === 4 &&
        octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
    );
};

const isIPPrefixList = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && value.every(isIPPrefix);

const wireGuardCreateIssue = (options: Record<string, unknown>): OutboundOptionIssue | null => {
    const peer = Array.isArray(options.peers) ? options.peers[0] : undefined;
    const firstPeer = peer && typeof peer === "object" && !Array.isArray(peer) ? peer : {};

    if (!isFilled(firstPeer.address)) {
        return { path: "server", message: "Enter a server address." };
    }
    if (
        !Number.isInteger(firstPeer.port) ||
        Number(firstPeer.port) < 1 ||
        Number(firstPeer.port) > 65535
    ) {
        return { path: "server_port", message: "Enter a server port from 1 to 65535." };
    }
    if (!isWireGuardKey(options.private_key)) {
        return { path: "private_key", message: "Enter a base64 WireGuard private key." };
    }
    if (!isIPPrefixList(options.address)) {
        return { path: "address", message: "Enter local IP prefixes, such as 10.0.0.2/32." };
    }
    if (!isWireGuardKey(firstPeer.public_key)) {
        return { path: "peer_public_key", message: "Enter a base64 peer public key." };
    }
    if (isFilled(firstPeer.pre_shared_key) && !isWireGuardKey(firstPeer.pre_shared_key)) {
        return { path: "pre_shared_key", message: "Enter a base64 pre-shared key." };
    }
    if (!isIPPrefixList(firstPeer.allowed_ips)) {
        return { path: "allowed_ips", message: "Enter allowed IP prefixes." };
    }
    return null;
};

export const outboundCreateIssue = (
    type: string,
    options: Record<string, unknown>,
): OutboundOptionIssue | null => {
    if (
        type &&
        !["direct", "block", "wireguard", ...Object.keys(OUTBOUND_TYPE_FIELDS)].includes(type)
    ) {
        return { path: "type", message: "Choose a supported outbound type." };
    }

    if (type === "wireguard") {
        return wireGuardCreateIssue(options);
    }

    if (type && !["direct", "block", "selector", "urltest", "tor", "bridge"].includes(type)) {
        if (!isFilled(options.server)) {
            return { path: "server", message: "Enter a server address." };
        }
        if (
            type !== "ssh" &&
            (!Number.isInteger(options.server_port) ||
                Number(options.server_port) < 1 ||
                Number(options.server_port) > 65535)
        ) {
            return { path: "server_port", message: "Enter a server port from 1 to 65535." };
        }
    }

    for (const entry of OUTBOUND_TYPE_FIELDS[type] ?? []) {
        if (
            entry.required &&
            (!entry.when || entry.when(options)) &&
            !isFilled(optionAt(options, entry.path))
        ) {
            return {
                path: entry.path,
                message:
                    entry.path === "method"
                        ? "Choose an encryption method."
                        : entry.path === "password"
                          ? "Enter a password."
                          : entry.path === "outbounds"
                            ? "Enter at least one outbound tag."
                            : `Enter ${entry.label.toLowerCase()}.`,
            };
        }
    }

    if (TLS_REQUIRED_TYPES.has(type) && optionAt(options, "tls.enabled") !== true) {
        return { path: "tls.enabled", message: "Enable TLS for this type." };
    }
    if (
        optionAt(options, "tls.reality.enabled") === true &&
        !isFilled(optionAt(options, "tls.reality.public_key"))
    ) {
        return { path: "tls.reality.public_key", message: "Enter the Reality public key." };
    }
    if (
        type === "snell" &&
        options.version === 6 &&
        typeof options.psk === "string" &&
        (new TextEncoder().encode(options.psk).length < 12 ||
            new TextEncoder().encode(options.psk).length > 255)
    ) {
        return { path: "psk", message: "Use a pre-shared key of 12 to 255 bytes for Snell 6." };
    }
    if (
        type === "selector" &&
        isFilled(options.default) &&
        Array.isArray(options.outbounds) &&
        !options.outbounds.includes(options.default)
    ) {
        return { path: "default", message: "Choose a default from the outbound tags." };
    }
    return null;
};
