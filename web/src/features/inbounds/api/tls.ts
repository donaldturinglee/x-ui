// A listener's TLS, as its dialog edits it.
//
// The listener carries it among its own options rather than naming a
// configuration kept somewhere else: `tls` is the block the core terminates
// with, and what a client is handed to meet it -- the uTLS fingerprint, the
// Reality public key, whether to verify at all -- is kept under the same key in
// `out_json`, beside the rest of what a client is told, since the core takes no
// such option on a listener. Neither is modelled: the fields are views over the
// two blocks, so whatever the core accepts that has no field is carried through
// an edit as it was.

// Where the proxy core documents the block, as the mark in the block's title
// leads to it.
export const TLS_DOCS = {
    href: "https://sing-box.sagernet.org/configuration/shared/tls/",
    label: "TLS",
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const objectOf = (value: unknown) => (isPlainObject(value) ? value : {});

// How a listener is served: in the clear, over TLS, or over Reality -- TLS with
// a handshake borrowed from a site the listener is not, which lets through only
// a client that knows its key.
export type Security = "none" | "tls" | "reality";

export type TlsKind = Exclude<Security, "none">;

export const SECURITIES: { value: Security; label: string }[] = [
    { value: "none", label: "None" },
    { value: "tls", label: "TLS" },
    { value: "reality", label: "Reality" },
];

export const securityLabel = (security: Security) =>
    SECURITIES.find(({ value }) => value === security)!.label;

// Which of them a listener is served with, read off the block the core takes:
// none without one, and Reality where the block carries Reality's own. Said of
// the block being there at all, as the reference says it: one written and
// switched off is still set up, and is what an edit would find.
export const securityOf = (options: Record<string, unknown>): Security =>
    !isPlainObject(options.tls) ? "none" : isPlainObject(options.tls.reality) ? "reality" : "tls";

// The two halves of a listener's TLS: what it terminates with and what a client
// is handed.
export interface TlsHalves {
    server: Record<string, unknown>;
    client: Record<string, unknown>;
}

export const tlsHalvesOf = (options: Record<string, unknown>): TlsHalves => ({
    server: objectOf(options.tls),
    client: objectOf(objectOf(options.out_json).tls),
});

// The options with both halves written back into them, or with neither for a
// listener served in the clear. A client half with nothing in it is not written,
// and an out_json left with nothing goes with it, so a listener that hands a
// client nothing beyond the server half carries no block saying so.
export const withTlsHalves = (
    options: Record<string, unknown>,
    halves: TlsHalves | null,
): Record<string, unknown> => {
    const { tls: _tls, out_json: outJson, ...rest } = options;
    const next = halves ? { ...rest, tls: halves.server } : rest;

    // An out_json that is not an object is not the panel's to write into. It is
    // kept as it was, and a client half has nowhere to go.
    if (outJson !== undefined && outJson !== null && !isPlainObject(outJson)) {
        return { ...next, out_json: outJson };
    }

    const { tls: _client, ...told } = objectOf(outJson);
    const outJsonNext =
        halves && Object.keys(halves.client).length ? { ...told, tls: halves.client } : told;

    return Object.keys(outJsonNext).length ? { ...next, out_json: outJsonNext } : next;
};

// The short ids a Reality server accepts, as the reference starts them: one left
// empty, which any client may use, and the rest one to eight random bytes long.
export const randomShortIds = () =>
    Array.from({ length: 24 }, (_, index) => {
        const length = 1 + (crypto.getRandomValues(new Uint8Array(1))[0] % 8);

        return index === 0
            ? ""
            : Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
                  byte.toString(16).padStart(2, "0"),
              ).join("");
    });

// Each kind as the reference starts it when it is switched to, letting go of
// what the other had: plain TLS switched on and nothing more, or Reality with
// its handshake port, a set of short ids, a public key still to fill in and the
// browser's fingerprint it is only ever spoken through.
export const startTls = (kind: TlsKind): TlsHalves =>
    kind === "reality"
        ? {
              server: {
                  enabled: true,
                  reality: {
                      enabled: true,
                      handshake: { server_port: 443 },
                      short_id: randomShortIds(),
                  },
                  server_name: "",
              },
              client: {
                  reality: { public_key: "" },
                  utls: { enabled: true, fingerprint: "chrome" },
              },
          }
        : { server: { enabled: true }, client: {} };

// The options with the listener served the way chosen: TLS or Reality started
// afresh, or neither.
export const withSecurity = (options: Record<string, unknown>, security: Security) =>
    withTlsHalves(options, security === "none" ? null : startTls(security));

// What the core's fields accept, by the names the reference gives them.
export const TLS_VERSIONS = ["1.0", "1.1", "1.2", "1.3"];

export const ALPN_PROTOCOLS = [
    { value: "h3", label: "H3" },
    { value: "h2", label: "H2" },
    { value: "http/1.1", label: "Http/1.1" },
];

export const CIPHER_SUITES = [
    { value: "TLS_RSA_WITH_AES_128_CBC_SHA", label: "RSA-AES128-CBC-SHA" },
    { value: "TLS_RSA_WITH_AES_256_CBC_SHA", label: "RSA-AES256-CBC-SHA" },
    { value: "TLS_RSA_WITH_AES_128_GCM_SHA256", label: "RSA-AES128-GCM-SHA256" },
    { value: "TLS_RSA_WITH_AES_256_GCM_SHA384", label: "RSA-AES256-GCM-SHA384" },
    { value: "TLS_AES_128_GCM_SHA256", label: "AES128-GCM-SHA256" },
    { value: "TLS_AES_256_GCM_SHA384", label: "AES256-GCM-SHA384" },
    { value: "TLS_CHACHA20_POLY1305_SHA256", label: "CHACHA20-POLY1305-SHA256" },
    { value: "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA", label: "ECDHE-ECDSA-AES128-CBC-SHA" },
    { value: "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA", label: "ECDHE-ECDSA-AES256-CBC-SHA" },
    { value: "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA", label: "ECDHE-RSA-AES128-CBC-SHA" },
    { value: "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA", label: "ECDHE-RSA-AES256-CBC-SHA" },
    { value: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", label: "ECDHE-ECDSA-AES128-GCM-SHA256" },
    { value: "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384", label: "ECDHE-ECDSA-AES256-GCM-SHA384" },
    { value: "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", label: "ECDHE-RSA-AES128-GCM-SHA256" },
    { value: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", label: "ECDHE-RSA-AES256-GCM-SHA384" },
    {
        value: "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
        label: "ECDHE-ECDSA-CHACHA20-POLY1305-SHA256",
    },
    {
        value: "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
        label: "ECDHE-RSA-CHACHA20-POLY1305-SHA256",
    },
];

export const FINGERPRINTS = [
    { value: "chrome", label: "Chrome" },
    { value: "firefox", label: "Firefox" },
    { value: "edge", label: "Microsoft Edge" },
    { value: "safari", label: "Apple Safari" },
    { value: "360", label: "360" },
    { value: "qq", label: "QQ" },
    { value: "ios", label: "Apple IOS" },
    { value: "android", label: "Android" },
    { value: "random", label: "Random" },
    { value: "randomized", label: "Randomized" },
];

export const CLIENT_AUTHENTICATIONS = [
    { value: "no", label: "No" },
    { value: "request", label: "Request" },
    { value: "require-any", label: "Require any" },
    { value: "verify-if-given", label: "Verify if given" },
    { value: "require-and-verify", label: "Require and verify" },
];

export const ROOT_STORES = [
    { value: "mozilla", label: "Mozilla" },
    { value: "chrome", label: "Chrome" },
];

export const SPOOF_METHODS = [
    { value: "wrong-sequence", label: "Wrong sequence" },
    { value: "wrong-checksum", label: "Wrong checksum" },
    { value: "wrong-ack", label: "Wrong ACK" },
    { value: "wrong-md5", label: "Wrong MD5 signature" },
    { value: "wrong-timestamp", label: "Wrong timestamp" },
];

// The groups of options the reference switches on and off from the foot of the
// block, each adding its fields to it while it is on. Most are only for plain
// TLS, the time difference only for Reality, and the handshake timeout for
// either. A group is on while any of its keys is in either half; switched on, it
// starts where the reference starts it, and switched off, its keys leave both
// halves.
export type TlsOption =
    | "sni"
    | "alpn"
    | "minVersion"
    | "maxVersion"
    | "cipherSuites"
    | "utls"
    | "mutual"
    | "store"
    | "ktls"
    | "spoof"
    | "maxTimeDifference"
    | "handshakeTimeout";

export const TLS_OPTIONS: { option: TlsOption; label: string; kinds: TlsKind[] }[] = [
    { option: "sni", label: "SNI", kinds: ["tls"] },
    { option: "alpn", label: "ALPN", kinds: ["tls"] },
    { option: "minVersion", label: "Minimum version", kinds: ["tls"] },
    { option: "maxVersion", label: "Maximum version", kinds: ["tls"] },
    { option: "cipherSuites", label: "Cipher suites", kinds: ["tls"] },
    { option: "utls", label: "UTLS", kinds: ["tls"] },
    { option: "mutual", label: "Mutual TLS", kinds: ["tls"] },
    { option: "store", label: "Root store", kinds: ["tls"] },
    { option: "ktls", label: "Kernel TLS", kinds: ["tls"] },
    { option: "spoof", label: "SNI spoof", kinds: ["tls"] },
    { option: "maxTimeDifference", label: "Max time difference", kinds: ["reality"] },
    { option: "handshakeTimeout", label: "Handshake timeout", kinds: ["tls", "reality"] },
];

// Where each group's keys live, and what it starts as. The time difference is
// the one kept inside the Reality block rather than beside it.
const TLS_OPTION_STARTS: Record<Exclude<TlsOption, "maxTimeDifference">, Partial<TlsHalves>> = {
    sni: { server: { server_name: "" } },
    alpn: { server: { alpn: ["h3", "h2", "http/1.1"] } },
    minVersion: { server: { min_version: "1.2" } },
    maxVersion: { server: { max_version: "1.3" } },
    cipherSuites: { server: { cipher_suites: [] } },
    utls: { client: { utls: { enabled: true, fingerprint: "chrome" } } },
    mutual: {
        server: { client_certificate_path: [] },
        client: { client_certificate_path: "", client_key_path: "" },
    },
    store: { server: { store: "mozilla" } },
    ktls: { server: { kernel_tx: false, kernel_rx: false } },
    spoof: { client: { spoof: "" } },
    handshakeTimeout: { server: { handshake_timeout: "15s" } },
};

// The keys a group owns beyond the ones it starts with, which go with it when it
// is switched off.
const TLS_OPTION_EXTRA_KEYS: Partial<
    Record<TlsOption, Partial<Record<keyof TlsHalves, string[]>>>
> = {
    mutual: {
        server: [
            "client_authentication",
            "client_certificate",
            "client_certificate_public_key_sha256",
        ],
        client: ["client_certificate", "client_key"],
    },
    spoof: { client: ["spoof_method"] },
};

const optionKeys = (option: Exclude<TlsOption, "maxTimeDifference">, half: keyof TlsHalves) => [
    ...Object.keys(TLS_OPTION_STARTS[option][half] ?? {}),
    ...(TLS_OPTION_EXTRA_KEYS[option]?.[half] ?? []),
];

const realityOf = (server: Record<string, unknown>) => objectOf(server.reality);

export const hasTlsOption = (halves: TlsHalves, option: TlsOption) => {
    if (option === "maxTimeDifference") {
        return realityOf(halves.server).max_time_difference !== undefined;
    }

    return (["server", "client"] as const).some((half) =>
        optionKeys(option, half).some((key) => halves[half][key] !== undefined),
    );
};

export const withTlsOption = (halves: TlsHalves, option: TlsOption, isOn: boolean): TlsHalves => {
    if (option === "maxTimeDifference") {
        const { max_time_difference: _, ...reality } = realityOf(halves.server);

        return {
            ...halves,
            server: {
                ...halves.server,
                reality: isOn ? { ...reality, max_time_difference: "1m" } : reality,
            },
        };
    }

    const half = (name: keyof TlsHalves) => {
        const rest = Object.fromEntries(
            Object.entries(halves[name]).filter(([key]) => !optionKeys(option, name).includes(key)),
        );

        return isOn ? { ...rest, ...TLS_OPTION_STARTS[option][name] } : rest;
    };

    return { server: half("server"), client: half("client") };
};

// PEM text as the core takes it inline: a line to an entry.
export const toLines = (text: string) => text.split("\n");

export const fromLines = (lines: unknown) =>
    Array.isArray(lines) ? lines.filter((line) => typeof line === "string").join("\n") : "";
