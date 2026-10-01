import { describe, expect, it } from "vitest";

import {
    dnsOf,
    dnsServerDials,
    dnsServerOptionsForType,
    dnsServerRequest,
    fromDnsRuleDraft,
    fromDnsServer,
    hasOwnDnsOptions,
    hasPath,
    hostsOf,
    isAddressed,
    isDnsChanged,
    moveRule,
    newDnsRuleDraft,
    ruleConditions,
    ruleKind,
    serverAddress,
    serverTls,
    toDnsRuleDraft,
    toDnsServer,
    withDns,
    withHosts,
    type DnsServer,
} from "@/features/dns/api";

const buildServer = (overrides: Partial<DnsServer> = {}): DnsServer => ({
    type: "udp",
    tag: "google",
    ...overrides,
});

describe("dnsOf", () => {
    it("reads the section with its lists as lists", () => {
        expect(dnsOf({ dns: { final: "google" } })).toEqual({
            final: "google",
            servers: [],
            rules: [],
        });
    });

    it("reads a document with no section, or no document at all, as an empty one", () => {
        expect(dnsOf({ log: {} })).toEqual({ servers: [], rules: [] });
        expect(dnsOf(undefined)).toEqual({ servers: [], rules: [] });
        // A section written by hand as something other than an object is not
        // something to build a page on.
        expect(dnsOf({ dns: [] })).toEqual({ servers: [], rules: [] });
    });
});

describe("withDns", () => {
    it("replaces the section and leaves the rest of the document as it was", () => {
        const config = { log: { level: "info" }, dns: { final: "google" }, route: { rules: [] } };

        expect(withDns(config, { final: "local" })).toEqual({
            log: { level: "info" },
            dns: { final: "local" },
            route: { rules: [] },
        });
    });

    it("leaves out an option cleared on the page rather than writing it empty", () => {
        // The core would read an empty strategy as one that was set.
        expect(withDns({}, { strategy: "", client_subnet: undefined, final: "google" })).toEqual({
            dns: { final: "google" },
        });
    });

    it("carries an option the page does not show through untouched", () => {
        expect(withDns({}, { independent_cache: true }).dns).toEqual({ independent_cache: true });
    });
});

describe("isDnsChanged", () => {
    const config = { dns: { servers: [buildServer()], final: "google" } };

    it("is not changed by a copy of what was read", () => {
        expect(isDnsChanged(config, dnsOf(config))).toBe(false);
    });

    it("is changed by an option set, and unchanged again once it is cleared", () => {
        expect(isDnsChanged(config, { ...dnsOf(config), strategy: "ipv4_only" })).toBe(true);
        expect(isDnsChanged(config, { ...dnsOf(config), strategy: undefined })).toBe(false);
    });

    it("is changed by a server added", () => {
        const dns = dnsOf(config);

        expect(
            isDnsChanged(config, { ...dns, servers: [...dns.servers!, buildServer({ tag: "b" })] }),
        ).toBe(true);
    });
});

describe("serverAddress", () => {
    it("reads where a server is asked off its options", () => {
        expect(serverAddress(buildServer({ server: "8.8.8.8", server_port: 53 }))).toEqual({
            address: "8.8.8.8",
            port: 53,
        });
    });

    it("says nothing for a server that is not asked over the network", () => {
        expect(serverAddress(buildServer({ type: "local" }))).toEqual({
            address: null,
            port: null,
        });
    });

    it("says nothing rather than rendering an option it cannot read", () => {
        expect(serverAddress(buildServer({ server: "" })).address).toBeNull();
        expect(serverAddress(buildServer({ server: 8 })).address).toBeNull();
        expect(serverAddress(buildServer({ server_port: "53" })).port).toBeNull();
    });
});

describe("serverTls", () => {
    it("tells a server with TLS switched off from one that was never given it", () => {
        expect(serverTls(buildServer({ tls: { enabled: true } }))).toBe("enabled");
        expect(serverTls(buildServer({ tls: {} }))).toBe("disabled");
        expect(serverTls(buildServer())).toBe("none");
    });
});

describe("ruleKind", () => {
    it("names a logical rule by how it combines the rules in it", () => {
        expect(ruleKind({ type: "logical", mode: "or", rules: [] })).toBe("Logical (or)");
        expect(ruleKind({ domain: ["a.com"] })).toBe("Simple");
    });
});

describe("ruleConditions", () => {
    it("counts what a simple rule matches on, and not what it does", () => {
        expect(
            ruleConditions({
                domain_suffix: [".cn"],
                query_type: ["A"],
                action: "route",
                server: "local",
                invert: true,
            }),
        ).toBe(2);
    });

    it("counts the rules a logical rule combines", () => {
        expect(ruleConditions({ type: "logical", mode: "and", rules: [{}, {}, {}] })).toBe(3);
    });
});

describe("moveRule", () => {
    it("takes a rule out of the order and puts it back in at another place", () => {
        const [a, b, c] = [{ server: "a" }, { server: "b" }, { server: "c" }];

        expect(moveRule([a, b, c], 2, 0)).toEqual([c, a, b]);
        expect(moveRule([a, b, c], 0, 2)).toEqual([b, c, a]);
    });

    it("leaves the order it was given alone", () => {
        const rules = [{ server: "a" }, { server: "b" }];

        moveRule(rules, 1, 0);

        expect(rules[0].server).toBe("a");
    });
});

describe("toDnsServer", () => {
    it("carries every option the page does not model through a round trip", () => {
        const server = buildServer({ server: "8.8.8.8", detour: "direct" });

        expect(toDnsServer(fromDnsServer(server))).toEqual(server);
    });

    it("lets the fields above win over a key typed into the document", () => {
        expect(toDnsServer({ type: "udp", tag: "google", options: '{"tag": "other"}' }).tag).toBe(
            "google",
        );
    });
});

describe("dnsServerRequest", () => {
    it("asks for a type and a tag with no spaces in it", () => {
        const request = { type: "udp", tag: "google", options: "" };

        expect(dnsServerRequest.safeParse(request).success).toBe(true);
        expect(dnsServerRequest.safeParse({ ...request, type: "" }).success).toBe(false);
        expect(dnsServerRequest.safeParse({ ...request, tag: "two words" }).success).toBe(false);
        expect(dnsServerRequest.safeParse({ ...request, options: "[]" }).success).toBe(false);
    });
});

describe("DNS server types", () => {
    it("ask at an address of their own only the servers asked over the network", () => {
        expect(isAddressed("udp")).toBe(true);
        expect(isAddressed("local")).toBe(false);
        expect(hasPath("https")).toBe(true);
        expect(hasPath("tls")).toBe(false);
    });

    it("dial out, bar the ones answered by a file, a range or something else", () => {
        expect(dnsServerDials("local")).toBe(true);
        expect(dnsServerDials("hosts")).toBe(false);
        expect(dnsServerDials("fakeip")).toBe(false);
        expect(dnsServerDials("resolved")).toBe(false);
    });

    it("keep a document of their own only where the reference has a block for it", () => {
        expect(hasOwnDnsOptions("tls")).toBe(true);
        expect(hasOwnDnsOptions("udp")).toBe(false);
        // A hosts file's names have a block of fields.
        expect(hasOwnDnsOptions("hosts")).toBe(false);
    });
});

describe("predefined hosts", () => {
    it("read each name with its addresses a comma apart, however they were written", () => {
        expect(hostsOf({ "router.lan": ["192.168.1.1", "fd00::1"], nas: "10.0.0.2" })).toEqual([
            { name: "router.lan", addresses: "192.168.1.1,fd00::1" },
            { name: "nas", addresses: "10.0.0.2" },
        ]);
        expect(hostsOf(undefined)).toEqual([]);
    });

    it("write back only the rows that name a host", () => {
        expect(
            withHosts([
                { name: " router.lan ", addresses: "192.168.1.1, fd00::1," },
                { name: "", addresses: "10.0.0.9" },
            ]),
        ).toEqual({ "router.lan": ["192.168.1.1", "fd00::1"] });
        expect(withHosts([{ name: "", addresses: "" }])).toBeUndefined();
    });
});

describe("dnsServerOptionsForType", () => {
    const options = {
        server: "8.8.8.8",
        server_port: 853,
        detour: "direct",
        tls: { enabled: true },
    };

    it("keeps where a server is asked and how it dials, as far as the new type does either", () => {
        expect(dnsServerOptionsForType(options, "udp")).toEqual({
            server: "8.8.8.8",
            server_port: 853,
            detour: "direct",
        });
        expect(dnsServerOptionsForType(options, "local")).toEqual({ detour: "direct" });
        expect(dnsServerOptionsForType(options, "fakeip")).toEqual({});
    });
});

describe("DNS rule drafts", () => {
    it("start a new rule as the reference does, matching every query", () => {
        expect(fromDnsRuleDraft(newDnsRuleDraft("google"))).toEqual({
            action: "route",
            server: "google",
        });
    });

    it("read a rule that names no action as one that routes", () => {
        expect(fromDnsRuleDraft(toDnsRuleDraft({ domain: ["a.com"], server: "google" }))).toEqual({
            domain: ["a.com"],
            action: "route",
            server: "google",
        });
    });

    it("carry a logical rule through a round trip", () => {
        const rule = {
            type: "logical",
            mode: "and",
            rules: [{ domain: ["a.com"] }, { port: [443] }],
            action: "route",
            server: "google",
            invert: true,
        };

        expect(fromDnsRuleDraft(toDnsRuleDraft(rule))).toEqual(rule);
    });

    it("write only what the action takes, and none of it left empty", () => {
        const draft = toDnsRuleDraft({ action: "reject", server: "google", no_drop: true });

        expect(fromDnsRuleDraft(draft)).toEqual({ action: "reject", no_drop: true });
        expect(
            fromDnsRuleDraft({
                ...draft,
                action: { action: "route-options", client_subnet: "", rewrite_ttl: 0 },
            }),
        ).toEqual({ action: "route-options" });
    });

    it("answer with records only where the answer is not an error", () => {
        const rule = {
            domain: ["a.com"],
            action: "predefined",
            rcode: "NOERROR",
            answer: ["a.com. IN A 127.0.0.1"],
        };

        expect(fromDnsRuleDraft(toDnsRuleDraft(rule))).toEqual(rule);
        expect(fromDnsRuleDraft(toDnsRuleDraft({ ...rule, rcode: "NXDOMAIN" }))).toEqual({
            domain: ["a.com"],
            action: "predefined",
            rcode: "NXDOMAIN",
        });
    });
});
