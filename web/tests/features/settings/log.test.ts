import { describe, expect, it } from "vitest";

import { isLogChanged, logOf, withLog } from "@/features/settings/api/log";

describe("logOf", () => {
    it("reads what the core logs as the document holds it", () => {
        expect(logOf({ log: { level: "warn", timestamp: true }, dns: { servers: [] } })).toEqual({
            level: "warn",
            timestamp: true,
        });
    });

    it("reads a document without the key, or no document at all, as nothing set", () => {
        expect(logOf({ dns: {} })).toEqual({});
        expect(logOf(undefined)).toEqual({});
        // Written by hand as something other than an object, it is nothing to
        // build a tab on.
        expect(logOf({ log: [] })).toEqual({});
        expect(logOf({ log: "info" })).toEqual({});
    });
});

describe("withLog", () => {
    it("replaces the key and leaves the rest of the document as it was", () => {
        const config = {
            log: { level: "info" },
            dns: { servers: [] },
            experimental: { cache_file: { enabled: true } },
        };

        expect(withLog(config, { level: "debug", timestamp: true })).toEqual({
            log: { level: "debug", timestamp: true },
            dns: { servers: [] },
            experimental: { cache_file: { enabled: true } },
        });
    });

    it("leaves out an option cleared on the tab", () => {
        expect(
            withLog({}, { level: "", output: undefined, disabled: undefined, timestamp: true }).log,
        ).toEqual({ timestamp: true });
    });

    it("carries an option the tab does not show through untouched", () => {
        expect(withLog({}, { level: "info", colours: false }).log).toEqual({
            level: "info",
            colours: false,
        });
    });
});

describe("isLogChanged", () => {
    const config = { log: { level: "info" } };

    it("is not changed by a copy of what was read", () => {
        expect(isLogChanged(config, logOf(config))).toBe(false);
    });

    it("is changed by an option set, and unchanged again once it is cleared", () => {
        expect(isLogChanged(config, { level: "debug" })).toBe(true);
        expect(isLogChanged(config, { level: "info", output: "" })).toBe(false);
    });
});
