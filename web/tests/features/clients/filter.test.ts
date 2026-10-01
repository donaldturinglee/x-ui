import { describe, expect, it } from "vitest";

import {
    CLIENTS_PER_PAGE,
    emptyFilter,
    fromClient,
    subscriptionURL,
    toClientQuery,
    type ClientFilter,
} from "@/features/clients/api";

import { buildClient } from "../../fixtures/clients";

const buildFilter = (overrides: Partial<ClientFilter> = {}): ClientFilter => ({
    ...emptyFilter,
    ...overrides,
});

describe("toClientQuery", () => {
    it("asks for a page and nothing else when nothing is narrowed", () => {
        // The key stays the same shape whether a filter was ever set, so
        // clearing one does not read as a different listing.
        expect(toClientQuery(emptyFilter)).toBe(`/clients?limit=${CLIENTS_PER_PAGE}`);
    });

    it("sends only what narrows something", () => {
        const query = toClientQuery(buildFilter({ group: "staff", search: "ali" }));

        expect(query).toContain("group=staff");
        expect(query).toContain("search=ali");
        expect(query).not.toContain("enabled=");
        expect(query).not.toContain("offset=");
    });

    it("tells a disabled filter from no filter at all", () => {
        // false narrows to the disabled subscribers; undefined asks for either,
        // and sending false for both would hide every working subscriber.
        expect(toClientQuery(buildFilter({ enabled: false }))).toContain("enabled=false");
        expect(toClientQuery(buildFilter({ enabled: true }))).toContain("enabled=true");
        expect(toClientQuery(buildFilter({ enabled: undefined }))).not.toContain("enabled=");
    });

    it("carries an offset once there is one", () => {
        expect(toClientQuery(buildFilter({ offset: 25 }))).toContain("offset=25");
    });

    it("asks for as many as a page is set to hold", () => {
        // Not part of the filter, so clearing one leaves the page size alone.
        expect(toClientQuery(emptyFilter, 50)).toBe("/clients?limit=50");
    });
});

describe("fromClient", () => {
    it("carries the listener assignment back", () => {
        // The API replaces the set with whatever an update sends, so a form that
        // opened without this would post an empty one and cut the subscriber off
        // from every listener they were connecting through.
        expect(fromClient(buildClient({ inbounds: [2, 5] })).inbounds).toEqual([2, 5]);
    });

    it("reads a subscriber with no assignment as an empty set", () => {
        expect(fromClient(buildClient({ inbounds: undefined })).inbounds).toEqual([]);
    });

    it("reads a quota in the unit it is typed in", () => {
        // Stored in bytes, typed in gigabytes: nobody sells a subscription by
        // the byte.
        expect(fromClient(buildClient({ volume: 10 * 1024 ** 3 })).volume).toBe(10);
    });
});

describe("subscriptionURL", () => {
    it("puts a subscriber's name on the deployment's base", () => {
        expect(subscriptionURL("https://sub.example.com/sub/", "alice")).toBe(
            "https://sub.example.com/sub/alice",
        );
    });

    it("does not double the separator when the base has none", () => {
        expect(subscriptionURL("https://sub.example.com/sub", "alice")).toBe(
            "https://sub.example.com/sub/alice",
        );
    });

    it("escapes a name that would otherwise change the path", () => {
        // The name is the subscription id and travels in a URL. The API refuses
        // a slash in one, but a link built here must not be the thing that
        // decides whether that held.
        expect(subscriptionURL("https://sub.example.com/sub/", "a b")).toBe(
            "https://sub.example.com/sub/a%20b",
        );
    });
});
