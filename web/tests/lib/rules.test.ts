import { describe, expect, it } from "vitest";

import {
    conditionChoices,
    conditionKey,
    hasCondition,
    listFor,
    withCondition,
    withConditionKey,
} from "@/lib/rules";

describe("conditions", () => {
    it("read a group as on while any of its keys is in the rule", () => {
        expect(hasCondition({ domain_regex: [] }, "domain")).toBe(true);
        expect(hasCondition({ rule_set_ip_cidr_match_source: false }, "ruleSet")).toBe(true);
        expect(hasCondition({ action: "route" }, "port")).toBe(false);
    });

    it("start a group switched on where the reference starts it", () => {
        expect(withCondition({ action: "route" }, "protocol", true, "route")).toEqual({
            action: "route",
            protocol: ["http"],
        });
        expect(withCondition({}, "ruleSet", true, "route")).toEqual({
            rule_set: [],
            rule_set_ip_cidr_match_source: false,
        });
        // A DNS rule has no addresses of its own to match a rule set's against.
        expect(withCondition({}, "ruleSet", true, "dns")).toEqual({ rule_set: [] });
    });

    it("take a group switched off out of the rule, whichever of its keys it has", () => {
        expect(
            withCondition({ ip_is_private: true, inbound: ["edge"] }, "domain", false, "route"),
        ).toEqual({ inbound: ["edge"] });
    });

    it("match a group of several on one key at a time", () => {
        expect(conditionKey({ port_range: ["1000:2000"] }, "port")).toBe("port_range");
        expect(conditionKey({}, "port")).toBe("port");
        expect(withConditionKey({ port: [53], action: "route" }, "port", "port_range")).toEqual({
            action: "route",
            port_range: [],
        });
        expect(withConditionKey({}, "sourceIp", "source_ip_is_private")).toEqual({
            source_ip_is_private: false,
        });
    });

    it("offer a DNS rule names to match rather than addresses", () => {
        expect(conditionChoices("domain", "dns")).not.toContain("ip_cidr");
        expect(conditionChoices("domain", "route")).toContain("ip_cidr");
    });
});

describe("listFor", () => {
    it("reads ports as the numbers the core takes, and leaves out what is not one", () => {
        expect(listFor("port", ["53", "443", "http"])).toEqual([53, 443]);
        expect(listFor("source_port", ["8080"])).toEqual([8080]);
    });

    it("keeps every other list as the text it is", () => {
        expect(listFor("port_range", ["1000:2000"])).toEqual(["1000:2000"]);
        expect(listFor("domain_suffix", [".cn"])).toEqual([".cn"]);
    });
});
