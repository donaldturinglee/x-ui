import { describe, expect, it } from "vitest";

import {
    carriesReality,
    carriesTls,
    clientsOf,
    cloneInbound,
    fromInbound,
    hasListenOption,
    inboundDoc,
    inboundRequest,
    isOptionsDocument,
    listensOn,
    optionsDocument,
    parseOptions,
    toInboundPayload,
    toOptionsDocument,
    udpTimeoutMinutes,
    withListenOption,
    withoutListenOptions,
    type Inbound,
    type InboundRequest,
} from "@/features/inbounds/api";

import { buildClient } from "../../fixtures/clients";

const buildInbound = (overrides: Partial<Inbound> = {}): Inbound => ({
    id: 1,
    type: "vless",
    tag: "edge",
    ...overrides,
});

const buildRequest = (overrides: Partial<InboundRequest> = {}): InboundRequest => ({
    type: "vless",
    tag: "edge",
    listen: "",
    listen_port: 0,
    security: "none",
    options: "",
    ...overrides,
});

describe("parseOptions", () => {
    it("reads an empty document as no options", () => {
        expect(parseOptions("")).toEqual({});
        expect(parseOptions("   \n ")).toEqual({});
    });

    it("reads a JSON object", () => {
        expect(parseOptions('{"listen_port": 443}')).toEqual({ listen_port: 443 });
    });

    it("refuses anything that is not an object", () => {
        // The options are merged into the record the API is sent, so an array or
        // a bare number would spread into something the core cannot read.
        expect(parseOptions("[1, 2]")).toBeNull();
        expect(parseOptions("443")).toBeNull();
        expect(parseOptions('"listen"')).toBeNull();
        expect(parseOptions("null")).toBeNull();
        expect(parseOptions("{listen_port: 443}")).toBeNull();
    });
});

describe("isOptionsDocument", () => {
    it("accepts what parseOptions could read", () => {
        expect(isOptionsDocument("")).toBe(true);
        expect(isOptionsDocument('{"listen": "::"}')).toBe(true);
        expect(isOptionsDocument("not json")).toBe(false);
    });
});

describe("toOptionsDocument", () => {
    it("holds back the fields the form has of its own", () => {
        const document = toOptionsDocument(
            buildInbound({ listen: "::", listen_port: 443, users: [{ name: "alice" }] }),
        );

        // Where a listener binds now has fields of its own, so it is not also
        // sitting in the document underneath them — an operator editing one
        // would otherwise be looking at two answers to the same question.
        expect(JSON.parse(document)).toEqual({ users: [{ name: "alice" }] });
        expect(document).not.toContain("listen");
        expect(document).not.toContain('"tag"');
    });

    it("keeps the TLS in the document, where its fields are views over it", () => {
        // It is one of the core's options rather than a field of the panel's,
        // and what a client is handed to meet it rides along in out_json.
        const document = toOptionsDocument(
            buildInbound({
                tls: { enabled: true, server_name: "edge.example.com" },
                out_json: { tls: { insecure: true } },
            }),
        );

        expect(JSON.parse(document)).toEqual({
            tls: { enabled: true, server_name: "edge.example.com" },
            out_json: { tls: { insecure: true } },
        });
    });

    it("reads a listener with nothing else on it as empty", () => {
        // Rather than a pair of braces for an operator to type inside.
        expect(toOptionsDocument(buildInbound())).toBe("");
    });
});

describe("toInboundPayload", () => {
    it("sends the options back alongside the named fields", () => {
        const payload = toInboundPayload(
            buildRequest({
                security: "tls",
                listen: "::",
                listen_port: 443,
                options: '{"sniff": true, "tls": {"enabled": true}}',
            }),
        );

        // The security is the choice that wrote the TLS block, and the block is
        // what the API is sent.
        expect(payload).toEqual({
            type: "vless",
            tag: "edge",
            listen: "::",
            listen_port: 443,
            sniff: true,
            tls: { enabled: true },
        });
    });

    it("leaves out a listen address and port that were never set", () => {
        // A tun or redirect listener binds neither. Writing "" and 0 in would be
        // the panel inventing configuration the core never had, and the next
        // generation would carry it to the node.
        const payload = toInboundPayload(buildRequest({ type: "tun" }));

        expect(payload).not.toHaveProperty("listen");
        expect(payload).not.toHaveProperty("listen_port");
    });

    it("lets the fields win over the same keys typed into the document", () => {
        // The document is where they used to live, so a document written before
        // they had fields must not override what is now on screen above it.
        const payload = toInboundPayload(
            buildRequest({
                listen: "127.0.0.1",
                listen_port: 8080,
                options: '{"listen": "::", "listen_port": 443}',
            }),
        );

        expect(payload.listen).toBe("127.0.0.1");
        expect(payload.listen_port).toBe(8080);
    });

    it("lets the fields above win over a key typed into the document", () => {
        // Otherwise the document could quietly rewrite the tag the operator
        // filled in, and the row they were editing would move somewhere else.
        const payload = toInboundPayload(
            buildRequest({ tag: "edge", options: '{"tag": "elsewhere", "type": "trojan"}' }),
        );

        expect(payload.tag).toBe("edge");
        expect(payload.type).toBe("vless");
    });
});

describe("fromInbound", () => {
    it("carries every option the panel does not model through a round trip", () => {
        // This is the whole reason the document is edited as a document: a form
        // that posted only the fields it knows would drop the rest, which for
        // most listener types is all of them.
        const inbound = buildInbound({
            listen_port: 443,
            transport: { type: "ws", path: "/sub" },
            addrs: ["edge.example.com"],
            tls: { enabled: true, curve_preferences: ["x25519"] },
            out_json: { tls: { utls: { enabled: true, fingerprint: "chrome" } } },
        });

        expect(toInboundPayload(fromInbound(inbound))).toEqual({
            type: "vless",
            tag: "edge",
            listen_port: 443,
            transport: { type: "ws", path: "/sub" },
            addrs: ["edge.example.com"],
            tls: { enabled: true, curve_preferences: ["x25519"] },
            out_json: { tls: { utls: { enabled: true, fingerprint: "chrome" } } },
        });
    });

    it("reads how a listener is served off its TLS block", () => {
        expect(fromInbound(buildInbound()).security).toBe("none");
        expect(fromInbound(buildInbound({ tls: { enabled: true } })).security).toBe("tls");
        expect(
            fromInbound(buildInbound({ tls: { enabled: true, reality: { enabled: true } } }))
                .security,
        ).toBe("reality");
    });

    it("leaves the id behind, which is the one field the API assigns", () => {
        expect(toInboundPayload(fromInbound(buildInbound()))).not.toHaveProperty("id");
    });

    it("reads where a listener binds into its own fields", () => {
        const request = fromInbound(buildInbound({ listen: "127.0.0.1", listen_port: 8080 }));

        expect(request.listen).toBe("127.0.0.1");
        expect(request.listen_port).toBe(8080);
        // And out of the document, so the form shows each of them once.
        expect(request.options).not.toContain("listen");
    });

    it("reads a listener that binds nothing as empty rather than as missing", () => {
        // A tun listener has neither key. The fields still have to hold
        // something the form can render, which is empty and zero.
        const request = fromInbound(buildInbound({ type: "tun" }));

        expect(request.listen).toBe("");
        expect(request.listen_port).toBe(0);
    });

    it("ignores a listen address the record stored as something else", () => {
        // Whatever is in the database reaches this untyped. A number in the
        // address field would be rendered into an input expecting a string.
        expect(fromInbound(buildInbound({ listen: 42 })).listen).toBe("");
    });
});

describe("cloneInbound", () => {
    it("carries everything the listener holds under a tag and port of its own", () => {
        const copy = cloneInbound(
            buildInbound({
                listen: "::",
                listen_port: 443,
                transport: { type: "ws", path: "/sub" },
                tls: { enabled: true },
            }),
            ["edge"],
        );

        // The options the panel does not model are what makes a copy worth
        // having, and they ride along the way an edit carries them -- its TLS
        // among them.
        expect(copy).toMatchObject({ type: "vless", listen: "::", security: "tls" });
        expect(JSON.parse(copy.options)).toEqual({
            transport: { type: "ws", path: "/sub" },
            tls: { enabled: true },
        });

        expect(copy.tag).toMatch(/^vless-[0-9A-Za-z]{3}$/);
        expect(copy.listen_port).toBeGreaterThanOrEqual(10_000);
        expect(copy.listen_port).toBeLessThanOrEqual(60_000);
    });

    it("draws the tag again when it lands on one that is taken", () => {
        // The first three draws spell vless-000, which another listener has.
        const draws = [0, 0, 0];
        const random = () => draws.shift() ?? 0.5;

        const copy = cloneInbound(buildInbound({ listen_port: 443 }), ["vless-000"], random);

        expect(copy.tag).toMatch(/^vless-/);
        expect(copy.tag).not.toBe("vless-000");
    });

    it("gives up drawing rather than looping, and leaves the refusal to the API", () => {
        // Nothing but chance picks the characters, so a draw that never changes
        // is not something to wait out.
        const copy = cloneInbound(buildInbound({ listen_port: 443 }), ["vless-000"], () => 0);

        expect(copy.tag).toBe("vless-000");
    });

    it("reaches both ends of the port range", () => {
        expect(cloneInbound(buildInbound({ listen_port: 443 }), [], () => 0).listen_port).toBe(
            10_000,
        );
        expect(
            cloneInbound(buildInbound({ listen_port: 443 }), [], () => 0.999_999_9).listen_port,
        ).toBe(60_000);
    });

    it("keeps a type that binds no port binding none", () => {
        // A tun listener has no port, and a copy of one inventing a port would
        // be configuration the core never had.
        expect(cloneInbound(buildInbound({ type: "tun" }), []).listen_port).toBe(0);
    });
});

describe("clientsOf", () => {
    it("names the subscribers who connect through a listener", () => {
        // A subscriber names the listeners they use, so who is on a listener is
        // read off the subscribers rather than the listener.
        const clients = [
            buildClient({ id: 1, name: "alice", inbounds: [1, 2] }),
            buildClient({ id: 2, name: "bob", inbounds: [2] }),
            buildClient({ id: 3, name: "carol" }),
        ];

        expect(clientsOf(clients, 2)).toEqual(["alice", "bob"]);
        expect(clientsOf(clients, 1)).toEqual(["alice"]);
        expect(clientsOf(clients, 3)).toEqual([]);
    });
});

describe("inboundRequest", () => {
    it("accepts what the API would", () => {
        expect(inboundRequest.safeParse(buildRequest()).success).toBe(true);
    });

    it("asks for a type and a tag", () => {
        expect(inboundRequest.safeParse(buildRequest({ type: "" })).success).toBe(false);
        expect(inboundRequest.safeParse(buildRequest({ tag: "" })).success).toBe(false);
        // A tag is named by route rules and reported traffic, so a space in one
        // is a reference that does not resolve.
        expect(inboundRequest.safeParse(buildRequest({ tag: "two words" })).success).toBe(false);
    });

    it("refuses a document that is not a JSON object", () => {
        expect(inboundRequest.safeParse(buildRequest({ options: "{" })).success).toBe(false);
        expect(inboundRequest.safeParse(buildRequest({ options: "[]" })).success).toBe(false);
    });

    it("refuses a port that is not one", () => {
        // Zero is allowed and means the listener binds none.
        expect(inboundRequest.safeParse(buildRequest({ listen_port: 0 })).success).toBe(true);
        expect(inboundRequest.safeParse(buildRequest({ listen_port: 65535 })).success).toBe(true);
        expect(inboundRequest.safeParse(buildRequest({ listen_port: 65536 })).success).toBe(false);
        expect(inboundRequest.safeParse(buildRequest({ listen_port: -1 })).success).toBe(false);
        expect(inboundRequest.safeParse(buildRequest({ listen_port: 44.5 })).success).toBe(false);
    });

    it("accepts an empty listen address, which binds every interface", () => {
        expect(inboundRequest.safeParse(buildRequest({ listen: "" })).success).toBe(true);
        expect(inboundRequest.safeParse(buildRequest({ listen: "127.0.0.1" })).success).toBe(true);
        expect(inboundRequest.safeParse(buildRequest({ listen: "1.2.3.4 5" })).success).toBe(false);
    });

    it("takes a type it does not know, which the core may have added", () => {
        // The list is what the form offers, not what it will accept: a record
        // carrying a newer core's type is edited rather than refused.
        expect(inboundRequest.safeParse(buildRequest({ type: "somethingnew" })).success).toBe(true);
    });

    it("refuses a type only served over TLS served in the clear", () => {
        const refused = inboundRequest.safeParse(buildRequest({ type: "hysteria2" }));

        expect(refused.success).toBe(false);
        // Said under the field that chose it.
        expect(refused.error?.issues[0]?.path).toEqual(["security"]);
        expect(refused.error?.issues[0]?.message).toBe(
            "A hysteria2 listener is only served over TLS: choose TLS.",
        );
        expect(
            inboundRequest.safeParse(buildRequest({ type: "hysteria2", security: "tls" })).success,
        ).toBe(true);
        // One Reality can be put in front of is offered that as well.
        expect(
            inboundRequest.safeParse(buildRequest({ type: "anytls" })).error?.issues[0]?.message,
        ).toBe("An anytls listener is only served over TLS: choose TLS or Reality.");
        // One that can go either way is left to choose.
        expect(inboundRequest.safeParse(buildRequest({ type: "vless" })).success).toBe(true);
    });

    it("refuses Reality in front of a type served over QUIC", () => {
        const refused = inboundRequest.safeParse(
            buildRequest({ type: "tuic", security: "reality" }),
        );

        expect(refused.success).toBe(false);
        expect(refused.error?.issues[0]?.path).toEqual(["security"]);
        expect(
            inboundRequest.safeParse(buildRequest({ type: "vless", security: "reality" })).success,
        ).toBe(true);
        // A type the panel does not know is left to the core.
        expect(
            inboundRequest.safeParse(buildRequest({ type: "somethingnew", security: "reality" }))
                .success,
        ).toBe(true);
    });
});

describe("listensOn, carriesTls and carriesReality", () => {
    it("knows the types that bind nothing", () => {
        expect(listensOn("vless")).toBe(true);
        expect(listensOn("tun")).toBe(false);
        expect(listensOn("cloudflared")).toBe(false);
        // Before a type is chosen, where it binds is still to be said.
        expect(listensOn("")).toBe(true);
    });

    it("knows the types TLS can be put in front of", () => {
        expect(carriesTls("vless")).toBe(true);
        expect(carriesTls("hysteria2")).toBe(true);
        expect(carriesTls("shadowsocks")).toBe(false);
        expect(carriesTls("")).toBe(false);
    });

    it("knows the ones Reality can be put in front of as well", () => {
        expect(carriesReality("vless")).toBe(true);
        expect(carriesReality("anytls")).toBe(true);
        // Served over QUIC, or to a client that has no Reality to speak.
        expect(carriesReality("hysteria2")).toBe(false);
        expect(carriesReality("naive")).toBe(false);
        expect(carriesReality("shadowsocks")).toBe(false);
    });
});

describe("inboundDoc", () => {
    it("leads to the core's page for the type, or for listeners before one is chosen", () => {
        expect(inboundDoc("vless")).toBe(
            "https://sing-box.sagernet.org/configuration/inbound/vless/",
        );
        expect(inboundDoc("")).toBe("https://sing-box.sagernet.org/configuration/inbound/");
    });
});

describe("listen options", () => {
    it("reads a group as on while its keys are in the document", () => {
        expect(hasListenOption({ tcp_fast_open: false, tcp_multi_path: false }, "tcp")).toBe(true);
        // Half of a pair is not the group switched on.
        expect(hasListenOption({ tcp_fast_open: true }, "tcp")).toBe(false);
        // Keep-alive is on with any one of its keys, as the reference reads it.
        expect(hasListenOption({ tcp_keep_alive_interval: "75s" }, "keepAlive")).toBe(true);
        expect(hasListenOption({ detour: "" }, "detour")).toBe(true);
        expect(hasListenOption({}, "udp")).toBe(false);
    });

    it("starts a group switched on where the reference starts it", () => {
        expect(withListenOption({ users: [] }, "udp", true)).toEqual({
            users: [],
            udp_fragment: false,
            udp_timeout: "5m",
        });
        expect(withListenOption({}, "keepAlive", true)).toEqual({
            tcp_keep_alive: "5m",
            tcp_keep_alive_interval: "75s",
        });
        expect(withListenOption({}, "detour", true, "relay")).toEqual({ detour: "relay" });
    });

    it("takes a group switched off out of the document, and nothing else", () => {
        const options = { users: [], tcp_fast_open: true, tcp_multi_path: false, detour: "relay" };

        expect(withListenOption(options, "tcp", false)).toEqual({ users: [], detour: "relay" });
        expect(withoutListenOptions(options)).toEqual({ users: [] });
    });

    it("reads a UDP expiry in minutes as the core writes it", () => {
        expect(udpTimeoutMinutes("10m")).toBe(10);
        expect(udpTimeoutMinutes("1h")).toBeNull();
        expect(udpTimeoutMinutes(undefined)).toBeNull();
    });
});

describe("optionsDocument", () => {
    it("writes options as the document the form carries, and none as nothing", () => {
        expect(JSON.parse(optionsDocument({ detour: "relay" }))).toEqual({ detour: "relay" });
        expect(optionsDocument({})).toBe("");
    });
});
