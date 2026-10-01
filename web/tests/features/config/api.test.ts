import { describe, expect, it } from "vitest";

import { parseConfig, toDocument } from "@/features/config/api";

describe("parseConfig", () => {
    it("reads an empty document as an empty configuration", () => {
        expect(parseConfig("")).toEqual({});
        expect(parseConfig("  \n ")).toEqual({});
    });

    it("refuses anything that is not an object", () => {
        // The document is posted as the body itself, so an array or a bare
        // value would be sent as something the API cannot read.
        expect(parseConfig("[]")).toBeNull();
        expect(parseConfig("7")).toBeNull();
        expect(parseConfig("{oops")).toBeNull();
    });
});

describe("toDocument", () => {
    it("writes the configuration as JSON a person can edit", () => {
        expect(JSON.parse(toDocument({ log: { level: "info" } }))).toEqual({
            log: { level: "info" },
        });
        expect(toDocument({ log: {} })).toContain("\n");
    });
});
