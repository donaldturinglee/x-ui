import { describe, expect, it } from "vitest";

import {
    experimentalOf,
    fromList,
    isExperimentalChanged,
    toList,
    withExperimental,
} from "@/features/settings/api/experimental";

describe("experimentalOf", () => {
    it("reads the core's interfaces as the document holds them", () => {
        expect(
            experimentalOf({
                log: { level: "info" },
                experimental: { cache_file: { enabled: true } },
            }),
        ).toEqual({ cache_file: { enabled: true } });
    });

    it("reads a document without the key, or no document at all, as none", () => {
        expect(experimentalOf({ log: {} })).toEqual({});
        expect(experimentalOf(undefined)).toEqual({});
        // Written by hand as something other than an object, it is nothing to
        // build a tab on.
        expect(experimentalOf({ experimental: [] })).toEqual({});
        expect(experimentalOf({ experimental: 1 })).toEqual({});
    });
});

describe("withExperimental", () => {
    it("replaces the key and leaves the rest of the document as it was", () => {
        const config = { log: { level: "info" }, dns: { servers: [] }, experimental: {} };

        expect(
            withExperimental(config, { clash_api: { external_controller: "127.0.0.1:9090" } }),
        ).toEqual({
            log: { level: "info" },
            dns: { servers: [] },
            experimental: { clash_api: { external_controller: "127.0.0.1:9090" } },
        });
    });

    it("leaves out an interface switched off, and an option cleared, however deep", () => {
        expect(
            withExperimental(
                {},
                {
                    clash_api: { external_controller: "127.0.0.1:9090", secret: "" },
                    cache_file: undefined,
                    v2ray_api: { listen: "127.0.0.1:8080", stats: { enabled: true, users: [] } },
                },
            ).experimental,
        ).toEqual({
            clash_api: { external_controller: "127.0.0.1:9090" },
            v2ray_api: { listen: "127.0.0.1:8080", stats: { enabled: true, users: [] } },
        });
    });

    it("carries an option the tab does not show through untouched", () => {
        const experimental = { clash_api: { external_ui: "ui", default_mode: "rule" } };

        expect(withExperimental({}, experimental).experimental).toEqual(experimental);
    });
});

describe("isExperimentalChanged", () => {
    const config = { log: { level: "info" }, experimental: {} };

    it("is not changed by a copy of what was read", () => {
        expect(isExperimentalChanged(config, experimentalOf(config))).toBe(false);
    });

    it("is changed by an interface switched on, and unchanged again once it is off", () => {
        expect(isExperimentalChanged(config, { cache_file: { enabled: true } })).toBe(true);
        expect(isExperimentalChanged(config, { cache_file: undefined })).toBe(false);
    });
});

describe("toList and fromList", () => {
    it("reads a comma separated list, leaving out space and empty items", () => {
        expect(toList(" https://a.example ,https://b.example,, ")).toEqual([
            "https://a.example",
            "https://b.example",
        ]);
        expect(toList("")).toEqual([]);
    });

    it("writes a list back as it is typed", () => {
        expect(fromList(["https://a.example", "https://b.example"])).toBe(
            "https://a.example, https://b.example",
        );
        // A document's own list may hold what is not a string, or not be one.
        expect(fromList(["edge", 1])).toBe("edge");
        expect(fromList(undefined)).toBe("");
    });
});
