import { describe, expect, it } from "vitest";

import {
    createOutboundRequest,
    destination,
    dials,
    editOutboundRequest,
    fromOutbound,
    hasDialOption,
    hasOwnOptions,
    isTerminal,
    OUTBOUND_TYPES,
    optionsDocument,
    optionsForType,
    outboundDocs,
    outboundRequest,
    peerOf,
    refusesAll,
    sendsToServer,
    serverOf,
    timeoutSeconds,
    tlsState,
    toOptionsDocument,
    toOutboundPayload,
    withDialOption,
    withPeer,
    withServerOption,
    type Outbound,
    type OutboundRequest,
} from "@/features/outbounds/api";
import { optionAt, outboundCreateIssue, withOptionAt } from "@/features/outbounds/api/field-specs";

const buildOutbound = (overrides: Partial<Outbound> = {}): Outbound => ({
    id: 1,
    type: "direct",
    tag: "out",
    ...overrides,
});

const buildRequest = (overrides: Partial<OutboundRequest> = {}): OutboundRequest => ({
    type: "direct",
    tag: "out",
    options: "",
    ...overrides,
});

describe("isTerminal", () => {
    it("tells an outcome apart from a hop", () => {
        // `direct` and `block` decide what happens on the node itself; every
        // other type hands the traffic to another server.
        expect(isTerminal(buildOutbound({ type: "direct" }))).toBe(true);
        expect(isTerminal(buildOutbound({ type: "block" }))).toBe(true);
        expect(isTerminal(buildOutbound({ type: "socks" }))).toBe(false);
    });
});

describe("destination", () => {
    it("reads the server and port off the stored options", () => {
        const outbound = buildOutbound({ type: "socks", server: "10.0.0.2", server_port: 1080 });

        expect(destination(outbound)).toEqual({ server: "10.0.0.2", port: 1080 });
    });

    it("reads a server with no port on its own", () => {
        const outbound = buildOutbound({ type: "socks", server: "10.0.0.2" });

        expect(destination(outbound)).toEqual({ server: "10.0.0.2", port: null });
    });

    it("says nothing for an outbound handled on the node", () => {
        // A direct outbound has no address to have, and a stray `server` left on
        // one is not something to render as though it routed there.
        expect(destination(buildOutbound({ type: "direct", server: "10.0.0.2" }))).toEqual({
            server: null,
            port: null,
        });
        expect(destination(buildOutbound({ type: "block" })).server).toBeNull();
    });

    it("says nothing rather than rendering an option it cannot read", () => {
        expect(destination(buildOutbound({ type: "socks" })).server).toBeNull();
        expect(destination(buildOutbound({ type: "socks", server: 42 })).server).toBeNull();
        expect(destination(buildOutbound({ type: "socks", server: "" })).server).toBeNull();
        expect(destination(buildOutbound({ type: "socks", server_port: "1080" })).port).toBeNull();
    });

    it("reads a WireGuard route's off the peer it sends to", () => {
        const tunnel = buildOutbound({
            type: "wireguard",
            peers: [{ address: "vpn.example.com", port: 51820 }, { address: "second.example.com" }],
        });

        expect(destination(tunnel)).toEqual({ server: "vpn.example.com", port: 51820 });
        // One with no peer yet has nowhere to show.
        expect(destination(buildOutbound({ type: "wireguard" }))).toEqual({
            server: null,
            port: null,
        });
    });
});

describe("tlsState", () => {
    it("tells a route with TLS switched off from one that was never given it", () => {
        expect(tlsState(buildOutbound({ tls: { enabled: true } }))).toBe("enabled");
        expect(tlsState(buildOutbound({ tls: { enabled: false } }))).toBe("disabled");
        expect(tlsState(buildOutbound({ tls: {} }))).toBe("disabled");
        expect(tlsState(buildOutbound())).toBe("none");
        expect(tlsState(buildOutbound({ tls: "yes" }))).toBe("none");
    });
});

describe("toOptionsDocument", () => {
    it("holds back the fields the form has of its own", () => {
        const document = toOptionsDocument(
            buildOutbound({ type: "socks", server: "10.0.0.2", server_port: 1080 }),
        );

        expect(JSON.parse(document)).toEqual({ server: "10.0.0.2", server_port: 1080 });
        expect(document).not.toContain('"tag"');
    });

    it("reads a route with nothing else on it as empty", () => {
        // A direct outbound is only a type and a tag.
        expect(toOptionsDocument(buildOutbound())).toBe("");
    });
});

describe("toOutboundPayload", () => {
    it("sends the options back alongside the named fields", () => {
        const payload = toOutboundPayload(
            buildRequest({ type: "socks", options: '{"server": "10.0.0.2"}' }),
        );

        expect(payload).toEqual({ type: "socks", tag: "out", server: "10.0.0.2" });
    });

    it("lets the fields above win over a key typed into the document", () => {
        // Otherwise the document could quietly rewrite the tag the operator
        // filled in, and the row they were editing would move somewhere else.
        const payload = toOutboundPayload(buildRequest({ options: '{"tag": "elsewhere"}' }));

        expect(payload.tag).toBe("out");
    });

    it("sends a block route as its type and tag alone", () => {
        // Options left on one from before are let go: the API refuses them, and
        // the dialog has no field to take them out with.
        const payload = toOutboundPayload(
            buildRequest({ type: "block", options: '{"server": "10.0.0.2"}' }),
        );

        expect(payload).toEqual({ type: "block", tag: "out" });
    });
});

describe("fromOutbound", () => {
    it("carries every option the panel does not model through a round trip", () => {
        const outbound = buildOutbound({
            type: "socks",
            server: "10.0.0.2",
            server_port: 1080,
            tls: { enabled: true },
        });

        expect(toOutboundPayload(fromOutbound(outbound))).toEqual({
            type: "socks",
            tag: "out",
            server: "10.0.0.2",
            server_port: 1080,
            tls: { enabled: true },
        });
    });

    it("leaves the id behind, which is the one field the API assigns", () => {
        expect(toOutboundPayload(fromOutbound(buildOutbound()))).not.toHaveProperty("id");
    });
});

describe("outboundRequest", () => {
    it("accepts what the API would", () => {
        expect(outboundRequest.safeParse(buildRequest()).success).toBe(true);
    });

    it("asks for a type and a tag", () => {
        expect(outboundRequest.safeParse(buildRequest({ type: "" })).success).toBe(false);
        expect(outboundRequest.safeParse(buildRequest({ tag: "" })).success).toBe(false);
        // Route rules name the tag, so a space in one is a detour that does not
        // resolve.
        expect(outboundRequest.safeParse(buildRequest({ tag: "two words" })).success).toBe(false);
    });

    it("refuses a document that is not a JSON object", () => {
        expect(outboundRequest.safeParse(buildRequest({ options: "{" })).success).toBe(false);
        expect(outboundRequest.safeParse(buildRequest({ options: "[]" })).success).toBe(false);
    });

    it("requires a method and password for a Shadowsocks route", () => {
        expect(outboundRequest.safeParse(buildRequest({ type: "shadowsocks" })).success).toBe(
            false,
        );
        expect(
            outboundRequest.safeParse(
                buildRequest({ type: "shadowsocks", options: '{"method":"aes-256-gcm"}' }),
            ).success,
        ).toBe(false);
        expect(
            outboundRequest.safeParse(
                buildRequest({
                    type: "shadowsocks",
                    options: '{"method":"aes-256-gcm","password":"secret"}',
                }),
            ).success,
        ).toBe(true);
    });

    it("takes a type it does not know, which the core may have added", () => {
        expect(outboundRequest.safeParse(buildRequest({ type: "somethingnew" })).success).toBe(
            true,
        );
    });
});

describe("OUTBOUND_TYPES", () => {
    it("offers a block route beside direct", () => {
        // The reference leaves it out; the core still takes it, and the two
        // decide on the node rather than sending traffic anywhere.
        expect(OUTBOUND_TYPES.slice(0, 3)).toEqual(["direct", "block", "socks"]);
    });

    it("offers WireGuard through the endpoint mapping and excludes removed types", () => {
        expect(OUTBOUND_TYPES).toContain("wireguard");
        expect(OUTBOUND_TYPES).not.toContain("dns");
        expect(OUTBOUND_TYPES).not.toContain("tailcat");
        expect(OUTBOUND_TYPES).toContain("naive");
    });
});

describe("sendsToServer, dials and hasOwnOptions", () => {
    it("knows the types with no server of their own", () => {
        expect(sendsToServer("socks")).toBe(true);
        expect(sendsToServer("direct")).toBe(false);
        expect(sendsToServer("block")).toBe(false);
        expect(sendsToServer("urltest")).toBe(false);
        expect(sendsToServer("tor")).toBe(false);
        expect(sendsToServer("bridge")).toBe(false);
    });

    it("knows the types that dial nothing", () => {
        expect(dials("direct")).toBe(true);
        expect(dials("tor")).toBe(true);
        expect(dials("block")).toBe(false);
        expect(dials("selector")).toBe(false);
        expect(dials("bridge")).toBe(false);
    });

    it("knows the types with no options of their own", () => {
        expect(hasOwnOptions("vless")).toBe(true);
        expect(hasOwnOptions("direct")).toBe(false);
        expect(hasOwnOptions("block")).toBe(false);
    });

    it("reads a type not chosen yet as the reference's first route out", () => {
        // Which dials, and has neither a server nor options of its own.
        expect(sendsToServer("")).toBe(false);
        expect(hasOwnOptions("")).toBe(false);
        expect(dials("")).toBe(true);
    });
});

describe("refusesAll", () => {
    it("knows the route that refuses whatever is sent to it", () => {
        expect(refusesAll("block")).toBe(true);
        // Direct decides on the node too, but lets the traffic out.
        expect(refusesAll("direct")).toBe(false);
        expect(refusesAll("socks")).toBe(false);
        expect(refusesAll("")).toBe(false);
    });
});

describe("outboundDocs", () => {
    it("leads to the core's page for the type, or for outbounds before one is chosen", () => {
        expect(outboundDocs("vless")).toEqual({
            href: "https://sing-box.sagernet.org/configuration/outbound/vless/",
            label: "vless route out",
        });
        expect(outboundDocs("").href).toBe("https://sing-box.sagernet.org/configuration/outbound/");
    });

    it("leads a WireGuard route to the endpoint the core documents it as", () => {
        expect(outboundDocs("wireguard")).toEqual({
            href: "https://sing-box.sagernet.org/configuration/endpoint/wireguard/",
            label: "WireGuard",
        });
    });
});

describe("dial options", () => {
    it("reads a group as on while its keys are in the document", () => {
        expect(hasDialOption({ tcp_fast_open: false, tcp_multi_path: false }, "tcp")).toBe(true);
        // Half of a pair is not the group switched on.
        expect(hasDialOption({ tcp_fast_open: true }, "tcp")).toBe(false);
        // Keep-alive is on with any one of its keys, as the reference reads it.
        expect(hasDialOption({ disable_tcp_keep_alive: true }, "keepAlive")).toBe(true);
        expect(hasDialOption({ detour: "" }, "detour")).toBe(true);
        expect(hasDialOption({}, "connectTimeout")).toBe(false);
    });

    it("starts a group switched on where the reference starts it", () => {
        expect(withDialOption({ server: "10.0.0.2" }, "connectTimeout", true)).toEqual({
            server: "10.0.0.2",
            connect_timeout: "5s",
        });
        expect(withDialOption({}, "udp", true)).toEqual({ udp_fragment: true });
        expect(withDialOption({}, "keepAlive", true)).toEqual({
            tcp_keep_alive: "5m",
            tcp_keep_alive_interval: "75s",
        });
        // The two that name something else start at the first there is, or at
        // nothing where there is none.
        expect(withDialOption({}, "detour", true, { detour: "upstream" })).toEqual({
            detour: "upstream",
        });
        expect(withDialOption({}, "domainResolver", true)).toEqual({ domain_resolver: "" });
    });

    it("takes a group switched off out of the document, and nothing else", () => {
        const options = { server: "10.0.0.2", tcp_keep_alive: "5m", disable_tcp_keep_alive: true };

        expect(withDialOption(options, "keepAlive", false)).toEqual({ server: "10.0.0.2" });
    });

    it("reads a connection timeout in seconds as the core writes it", () => {
        expect(timeoutSeconds("10s")).toBe(10);
        expect(timeoutSeconds("1m")).toBeNull();
        expect(timeoutSeconds(undefined)).toBeNull();
    });
});

describe("optionsForType", () => {
    const options = {
        server: "10.0.0.2",
        server_port: 1080,
        username: "alice",
        connect_timeout: "5s",
    };

    it("keeps where a route sends and how it dials, and none of the old type's own", () => {
        expect(optionsForType(options, "http")).toEqual({
            server: "10.0.0.2",
            server_port: 1080,
            connect_timeout: "5s",
        });
    });

    it("keeps only what the new type has", () => {
        // A direct route dials but sends to no server; a selector does neither,
        // and nor does a block route, which keeps nothing at all.
        expect(optionsForType(options, "direct")).toEqual({ connect_timeout: "5s" });
        expect(optionsForType(options, "selector")).toEqual({});
        expect(optionsForType(options, "block")).toEqual({});
    });

    it("moves where a route sends into a WireGuard route's peer, which allows everything", () => {
        expect(optionsForType(options, "wireguard", "socks")).toEqual({
            peers: [
                {
                    address: "10.0.0.2",
                    port: 1080,
                    allowed_ips: ["0.0.0.0/0", "::/0"],
                },
            ],
            connect_timeout: "5s",
        });
        expect(optionsForType({}, "wireguard")).toEqual({
            peers: [{ allowed_ips: ["0.0.0.0/0", "::/0"] }],
        });
    });

    it("moves where a WireGuard route sends back out of its peer", () => {
        const tunnel = {
            private_key: "private",
            peers: [{ address: "vpn.example.com", port: 51820, public_key: "public" }],
        };

        expect(optionsForType(tunnel, "socks", "wireguard")).toEqual({
            server: "vpn.example.com",
            server_port: 51820,
        });
    });

    it("starts TLS for types that require it", () => {
        expect(optionsForType({}, "hysteria2")).toEqual({ tls: { enabled: true } });
        expect(optionsForType({}, "vless")).toEqual({});
    });
});

describe("createOutboundRequest", () => {
    const create = (type: string, options: Record<string, unknown>) =>
        createOutboundRequest.safeParse(buildRequest({ type, options: optionsDocument(options) }));

    it("requires the destination and each protocol's required fields", () => {
        expect(create("socks", {}).success).toBe(false);
        expect(create("socks", { server: "proxy.example", server_port: 1080 }).success).toBe(true);
        expect(create("vmess", { server: "proxy.example", server_port: 443 }).success).toBe(false);
        expect(
            create("vmess", {
                server: "proxy.example",
                server_port: 443,
                uuid: "bf000d23-0752-40b4-affe-68f7707a9661",
            }).success,
        ).toBe(true);
        expect(create("selector", { outbounds: [] }).success).toBe(false);
        expect(create("selector", { outbounds: ["out"] }).success).toBe(true);
        expect(create("selector", { outbounds: ["out"], default: "missing" }).success).toBe(false);
    });

    it("requires TLS for the protocols that need it and Reality's public key when enabled", () => {
        const server = { server: "proxy.example", server_port: 443 };
        expect(create("hysteria2", server).success).toBe(false);
        expect(create("hysteria2", { ...server, tls: { enabled: true } }).success).toBe(true);
        const vless = { ...server, uuid: "bf000d23-0752-40b4-affe-68f7707a9661" };
        expect(
            create("vless", { ...vless, tls: { enabled: true, reality: { enabled: true } } })
                .success,
        ).toBe(false);
        expect(
            create("vless", {
                ...vless,
                tls: { enabled: true, reality: { enabled: true, public_key: "key" } },
            }).success,
        ).toBe(true);
    });

    it("creates a WireGuard route with endpoint fields and checks each required field", () => {
        const key = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
        const peerKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
        const peer = {
            address: "vpn.example.com",
            port: 51820,
            public_key: peerKey,
            allowed_ips: ["0.0.0.0/0", "::/0"],
        };
        const options = {
            private_key: key,
            address: ["10.9.0.2/32", "fd00::2/128"],
            peers: [peer],
        };

        expect(create("wireguard", options).success).toBe(true);
        expect(
            toOutboundPayload(
                buildRequest({ type: "wireguard", options: optionsDocument(options) }),
            ),
        ).toEqual({
            type: "wireguard",
            tag: "out",
            ...options,
        });
        expect(
            outboundCreateIssue("wireguard", { ...options, peers: [{ ...peer, port: 0 }] })?.path,
        ).toBe("server_port");
        expect(outboundCreateIssue("wireguard", { ...options, private_key: "invalid" })?.path).toBe(
            "private_key",
        );
        expect(
            outboundCreateIssue("wireguard", { ...options, address: ["10.9.0.2/33"] })?.path,
        ).toBe("address");
        expect(
            outboundCreateIssue("wireguard", { ...options, peers: [{ ...peer, public_key: "" }] })
                ?.path,
        ).toBe("peer_public_key");
        expect(
            outboundCreateIssue("wireguard", { ...options, peers: [{ ...peer, allowed_ips: [] }] })
                ?.path,
        ).toBe("allowed_ips");
    });

    it("refuses removed and unknown outbound types at creation", () => {
        expect(create("dns", {}).success).toBe(false);
        expect(create("tailcat", {}).success).toBe(false);
    });

    it("checks the Snell 6 key length in bytes", () => {
        const server = { server: "proxy.example", server_port: 443, version: 6 };
        expect(create("snell", { ...server, psk: "short" }).success).toBe(false);
        expect(create("snell", { ...server, psk: "a secure key for Snell" }).success).toBe(true);
    });
});

describe("editOutboundRequest", () => {
    it("checks displayed fields while accepting newer types and retaining their options", () => {
        expect(
            editOutboundRequest.safeParse(
                buildRequest({
                    type: "socks",
                    options: optionsDocument({ server: "proxy.example" }),
                }),
            ).success,
        ).toBe(false);
        expect(
            editOutboundRequest.safeParse(
                buildRequest({
                    type: "socks",
                    options: optionsDocument({ server: "proxy.example", server_port: 1080 }),
                }),
            ).success,
        ).toBe(true);
        expect(
            editOutboundRequest.safeParse(
                buildRequest({ type: "future-type", options: optionsDocument({ future: true }) }),
            ).success,
        ).toBe(true);
    });
});

describe("nested outbound fields", () => {
    it("writes TLS and transport fields without losing siblings", () => {
        const options = { tls: { enabled: true, server_name: "example.com" } };
        const next = withOptionAt(options, "tls.reality.public_key", "public");

        expect(optionAt(next, "tls.reality.public_key")).toBe("public");
        expect(next.tls).toEqual({
            enabled: true,
            server_name: "example.com",
            reality: { public_key: "public" },
        });
        expect(withOptionAt(next, "tls.reality", undefined).tls).toEqual(options.tls);
    });
});

describe("serverOf and withServerOption", () => {
    it("read and write a server's own keys", () => {
        const options = { server: "10.0.0.2", server_port: 1080 };

        expect(serverOf("socks", options)).toEqual({ server: "10.0.0.2", port: 1080 });
        expect(withServerOption("socks", options, "port", 1081)).toEqual({
            server: "10.0.0.2",
            server_port: 1081,
        });
        // Cleared, the port is written as nothing, which leaves the document.
        expect(
            JSON.parse(optionsDocument(withServerOption("socks", options, "port", undefined))),
        ).toEqual({ server: "10.0.0.2" });
    });

    it("read and write a WireGuard route's first peer, and leave the rest alone", () => {
        const options = {
            mtu: 1420,
            peers: [{ address: "vpn.example.com", public_key: "first" }, { address: "second" }],
        };

        expect(serverOf("wireguard", options)).toEqual({ server: "vpn.example.com", port: null });
        expect(withServerOption("wireguard", options, "port", 51820)).toEqual({
            mtu: 1420,
            peers: [
                { address: "vpn.example.com", public_key: "first", port: 51820 },
                { address: "second" },
            ],
        });
    });
});

describe("peerOf and withPeer", () => {
    it("read a WireGuard route's first peer as nothing where there is none to read", () => {
        expect(peerOf({})).toEqual({});
        expect(peerOf({ peers: "none" })).toEqual({});
        expect(peerOf({ peers: ["not a peer"] })).toEqual({});
    });

    it("start a peer where there is none", () => {
        expect(withPeer({ mtu: 1420 }, { public_key: "public" })).toEqual({
            mtu: 1420,
            peers: [{ public_key: "public" }],
        });
    });
});

describe("optionsDocument", () => {
    it("writes options as the document the form edits, and none as nothing", () => {
        expect(JSON.parse(optionsDocument({ server: "10.0.0.2" }))).toEqual({
            server: "10.0.0.2",
        });
        expect(optionsDocument({})).toBe("");
    });
});
