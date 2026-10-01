import { describe, expect, it } from "vitest";

import { changesQuery, describeSubject, isAutomated, type Change } from "@/features/audit/api";

const buildChange = (overrides: Partial<Change> = {}): Change => ({
    id: 1,
    dateTime: 1_700_000_000,
    actor: "operator",
    key: "clients",
    action: "edit",
    obj: null,
    ...overrides,
});

describe("changesQuery", () => {
    it("asks the API for one actor's changes, or for everybody's", () => {
        expect(changesQuery()).toBe("/changes");
        expect(changesQuery("ops team")).toBe("/changes?actor=ops%20team");
    });
});

describe("isAutomated", () => {
    it("tells a job apart from an operator", () => {
        // Which of the two it was is usually the question being asked of this
        // log: "somebody did this" and "the quota ran out" are different
        // answers.
        expect(isAutomated(buildChange({ actor: "DepleteJob" }))).toBe(true);
        expect(isAutomated(buildChange({ actor: "ResetJob" }))).toBe(true);
        expect(isAutomated(buildChange({ actor: "operator" }))).toBe(false);
    });
});

describe("describeSubject", () => {
    it("reads the name of whatever changed", () => {
        expect(describeSubject(buildChange({ obj: { id: 4, name: "alice" } }))).toBe("alice");
    });

    it("falls back to a tag for objects that have one instead", () => {
        expect(describeSubject(buildChange({ obj: { id: 2, tag: "edge" } }))).toBe("edge");
    });

    it("reads a bare string as written", () => {
        // A global reset records "all" rather than naming every subscriber.
        expect(describeSubject(buildChange({ obj: "all" }))).toBe("all");
    });

    it("falls back to the id when there is no name", () => {
        expect(describeSubject(buildChange({ obj: { id: 7 } }))).toBe("#7");
    });

    it("says nothing rather than rendering an object", () => {
        // An entry the panel cannot summarise must not put a stringified object
        // in a table cell.
        expect(describeSubject(buildChange({ obj: null }))).toBe("—");
        expect(describeSubject(buildChange({ obj: { unexpected: true } }))).toBe("—");
    });
});
