import { describe, expect, it } from "vitest";

import {
    downloadDetour,
    fromRuleDraft,
    fromRuleSet,
    importRoute,
    isPlainDirect,
    isRouteChanged,
    newRuleDraft,
    readRouteBlock,
    readUrls,
    remoteRuleSet,
    resolverOf,
    routeOf,
    ruleConditions,
    tagFromUrl,
    toRuleDraft,
    toRuleSet,
    withRoute,
} from "@/features/rules/api";

describe("routeOf", () => {
    it("reads the section with its lists as lists", () => {
        expect(routeOf({ route: { final: "out" } })).toEqual({
            final: "out",
            rules: [],
            rule_set: [],
        });
        expect(routeOf(undefined)).toEqual({ rules: [], rule_set: [] });
    });
});

describe("withRoute", () => {
    it("replaces the section and leaves the rest of the document as it was", () => {
        const config = { log: { level: "info" }, route: { final: "out" }, dns: {} };

        expect(withRoute(config, { final: "upstream", default_interface: "" })).toEqual({
            log: { level: "info" },
            route: { final: "upstream" },
            dns: {},
        });
    });
});

describe("isRouteChanged", () => {
    const config = { route: { final: "out", rules: [{ action: "sniff" }] } };

    it("is not changed by a copy of what was read, and is by an edit", () => {
        expect(isRouteChanged(config, routeOf(config))).toBe(false);
        expect(isRouteChanged(config, { ...routeOf(config), final: "upstream" })).toBe(true);
    });
});

describe("resolverOf", () => {
    it("reads the server whether it is named alone or with options", () => {
        expect(resolverOf({ default_domain_resolver: "local" })).toBe("local");
        expect(
            resolverOf({ default_domain_resolver: { server: "local", strategy: "ipv4_only" } }),
        ).toBe("local");
        expect(resolverOf({})).toBe("");
    });
});

describe("ruleConditions", () => {
    it("counts what a rule matches on, and not what it does with it", () => {
        expect(ruleConditions({ action: "sniff" })).toBe(0);
        expect(
            ruleConditions({
                rule_set: ["ads"],
                protocol: ["dns"],
                action: "route",
                outbound: "x",
            }),
        ).toBe(2);
        expect(ruleConditions({ type: "logical", mode: "or", rules: [{}, {}] })).toBe(2);
    });
});

describe("rule drafts", () => {
    it("start a new rule as the reference does, matching everything", () => {
        expect(fromRuleDraft(newRuleDraft("out"))).toEqual({ action: "route", outbound: "out" });
    });

    it("carry a simple rule through a round trip", () => {
        const rule = { domain_suffix: [".cn"], network_strategy: "fallback", action: "sniff" };

        expect(fromRuleDraft(toRuleDraft(rule))).toEqual(rule);
    });

    it("carry a logical rule through a round trip, and what else it carries", () => {
        const rule = {
            type: "logical",
            mode: "or",
            rules: [{ domain_suffix: [".cn"] }, { protocol: ["bittorrent"] }],
            action: "route",
            outbound: "out",
            invert: true,
            note: "kept",
        };

        expect(fromRuleDraft(toRuleDraft(rule))).toEqual(rule);
    });

    it("write only what the action takes, and none of it left empty", () => {
        const draft = toRuleDraft({ action: "reject", method: "drop", outbound: "out" });

        expect(fromRuleDraft(draft)).toEqual({ action: "reject", method: "drop" });
        expect(
            fromRuleDraft({
                ...draft,
                action: { action: "route-options", override_address: "", override_port: 0 },
            }),
        ).toEqual({ action: "route-options" });
    });

    it("keep the first rule's conditions when a logical rule is made simple", () => {
        const draft = toRuleDraft({
            type: "logical",
            mode: "and",
            rules: [{ inbound: ["edge"] }, { port: [53] }],
            action: "hijack-dns",
        });

        expect(fromRuleDraft({ ...draft, logical: false })).toEqual({
            inbound: ["edge"],
            action: "hijack-dns",
        });
    });
});

describe("toRuleSet", () => {
    it("carries every option the page does not model through a round trip", () => {
        const ruleSet = {
            type: "remote",
            tag: "ads",
            format: "binary",
            url: "https://example.com/ads.srs",
            http_client: { detour: "upstream" },
        };

        expect(toRuleSet(fromRuleSet(ruleSet))).toEqual(ruleSet);
    });

    it("writes no format for one that has none", () => {
        expect(
            toRuleSet({ type: "inline", tag: "mine", format: "", options: '{"rules": []}' }),
        ).toEqual({ type: "inline", tag: "mine", rules: [] });
    });
});

describe("downloadDetour", () => {
    it("reads the route out a rule set is fetched through, where it names one", () => {
        expect(downloadDetour({ type: "remote", tag: "a", http_client: { detour: "up" } })).toBe(
            "up",
        );
        // A shared client is named by its tag, which is not a route out.
        expect(downloadDetour({ type: "remote", tag: "a", http_client: "shared" })).toBeNull();
        expect(downloadDetour({ type: "local", tag: "a" })).toBeNull();
    });
});

describe("readRouteBlock", () => {
    it("takes the route section out of a whole configuration", () => {
        expect(
            readRouteBlock(JSON.stringify({ log: {}, route: { rules: [{}], final: "out" } })),
        ).toEqual({ rules: [{}], rule_set: [], final: "out" });
    });

    it("takes a bare section as it is", () => {
        expect(readRouteBlock('{"rule_set": [{"tag": "a", "type": "local"}]}')).toEqual({
            rules: [],
            rule_set: [{ tag: "a", type: "local" }],
        });
    });

    it("finds nothing in a document without either list", () => {
        expect(readRouteBlock('{"log": {}}')).toBeNull();
        expect(readRouteBlock("not json")).toBeNull();
        expect(readRouteBlock("")).toBeNull();
    });
});

describe("importRoute", () => {
    const route = {
        final: "out",
        rules: [{ action: "sniff" }],
        rule_set: [{ type: "local", tag: "a" }],
    };
    const block = {
        rules: [{ action: "reject" }],
        rule_set: [
            { type: "local", tag: "a" },
            { type: "local", tag: "b" },
        ],
        final: "upstream",
    };

    it("adds after what is there, leaving out a rule set whose tag is taken", () => {
        expect(importRoute(route, block, "merge", false)).toEqual({
            final: "out",
            rules: [{ action: "sniff" }, { action: "reject" }],
            rule_set: [
                { type: "local", tag: "a" },
                { type: "local", tag: "b" },
            ],
        });
    });

    it("replaces what is there, and takes the final route out when asked", () => {
        expect(importRoute(route, block, "replace", true)).toEqual({
            final: "upstream",
            rules: [{ action: "reject" }],
            rule_set: block.rule_set,
        });
    });
});

describe("rule sets from addresses", () => {
    it("are tagged with the name of the file they point at", () => {
        expect(tagFromUrl("https://example.com/geo/geosite-youtube.srs")).toBe("geosite-youtube");
        expect(tagFromUrl("https://example.com/a/b/ads.json?v=2")).toBe("ads");
    });

    it("are read one to a line, each only once", () => {
        expect(
            readUrls("https://a/x.srs\n\n  https://a/x.srs \nnot a url\nhttps://b/y.srs"),
        ).toEqual(["https://a/x.srs", "https://b/y.srs"]);
    });

    it("are written with a download route and an interval only where they have one", () => {
        expect(remoteRuleSet({ tag: "a", url: "u", format: "binary", days: 0 })).toEqual({
            type: "remote",
            tag: "a",
            format: "binary",
            url: "u",
        });
        expect(
            remoteRuleSet({ tag: "a", url: "u", format: "source", detour: "up", days: 3 }),
        ).toEqual({
            type: "remote",
            tag: "a",
            format: "source",
            url: "u",
            http_client: { detour: "up" },
            update_interval: "3d",
        });
    });
});

describe("isPlainDirect", () => {
    it("tells a direct route out with nothing set on it from one with options", () => {
        expect(isPlainDirect({ id: 1, type: "direct", tag: "out" })).toBe(true);
        expect(isPlainDirect({ id: 1, type: "direct", tag: "out", bind_interface: "eth0" })).toBe(
            false,
        );
        expect(isPlainDirect({ id: 2, type: "socks", tag: "up" })).toBe(false);
        expect(isPlainDirect(undefined)).toBe(false);
    });
});
