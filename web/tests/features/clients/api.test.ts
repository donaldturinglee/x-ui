import { describe, expect, it } from "vitest";

import {
    clientRequest,
    daysLeft,
    expiryState,
    fromClient,
    fromExpiry,
    fromVolume,
    IDENTITIES,
    quotaState,
    quotaTone,
    toClientPayload,
    toExpiry,
    toVolume,
    usedBytes,
    usedFraction,
    withIdentityDrawn,
    withoutEmptyCredentials,
    type ClientRequest,
} from "@/features/clients/api";

import { buildClient, GIGABYTE } from "../../fixtures/clients";

const validRequest: ClientRequest = {
    name: "alice",
    enable: true,
    desc: "",
    group: "",
    remark: "",
    volume: 10,
    expiry: "",
    delayStart: false,
    autoReset: false,
    resetDays: 0,
    inbounds: [],
};

describe("quota conversion", () => {
    it("reads in gigabytes and bills in bytes", () => {
        // Nobody sells a subscription by the byte, and typing one out is how a
        // zero goes missing.
        expect(toVolume(10)).toBe(10 * GIGABYTE);
        expect(fromVolume(10 * GIGABYTE)).toBe(10);
    });

    it("round trips", () => {
        expect(fromVolume(toVolume(2.5))).toBeCloseTo(2.5);
    });
});

describe("expiry conversion", () => {
    it("treats an empty field as never expiring", () => {
        // Not as expiring at the epoch, which is what a plain parse would make
        // of it and would cut off every subscriber who was never given a date.
        expect(toExpiry("")).toBe(0);
        expect(fromExpiry(0)).toBe("");
    });

    it("round trips a date through the local day it names", () => {
        // `toISOString` is UTC and a date field is read locally, so a
        // subscription set to expire today must not read back as yesterday for
        // anyone west of Greenwich.
        expect(fromExpiry(toExpiry("2026-03-14"))).toBe("2026-03-14");
    });

    it("ignores something that is not a date", () => {
        expect(toExpiry("not-a-date")).toBe(0);
    });
});

describe("clientRequest", () => {
    it("accepts a subscriber the API would take", () => {
        expect(clientRequest.safeParse(validRequest).success).toBe(true);
    });

    it("refuses a name that would not survive a URL", () => {
        // The name is the subscription id, so it travels in a URL. A space or a
        // slash in one is a link that does not resolve.
        for (const name of ["two words", "a/b", "who?", "frag#ment"]) {
            expect(clientRequest.safeParse({ ...validRequest, name }).success).toBe(false);
        }
    });

    it("refuses an empty name", () => {
        expect(clientRequest.safeParse({ ...validRequest, name: "" }).success).toBe(false);
    });

    it("refuses a repeating quota with no period", () => {
        // At zero days the next reset lands on the moment it is computed, so the
        // quota resets every time the worker runs and is never reached.
        const result = clientRequest.safeParse({
            ...validRequest,
            autoReset: true,
            resetDays: 0,
        });

        expect(result.success).toBe(false);
    });

    it("accepts a repeating quota with a period", () => {
        const result = clientRequest.safeParse({
            ...validRequest,
            autoReset: true,
            resetDays: 30,
        });

        expect(result.success).toBe(true);
    });

    it("refuses a negative quota", () => {
        expect(clientRequest.safeParse({ ...validRequest, volume: -1 }).success).toBe(false);
    });

    it("refuses a clock held with no days to run once it starts", () => {
        // The held clock is started as that many days, so at none it would end
        // as it began.
        expect(
            clientRequest.safeParse({ ...validRequest, delayStart: true, resetDays: 0 }).success,
        ).toBe(false);
        expect(
            clientRequest.safeParse({ ...validRequest, delayStart: true, resetDays: 7 }).success,
        ).toBe(true);
    });
});

describe("toClientPayload", () => {
    it("sends what the API stores rather than what was typed", () => {
        const payload = toClientPayload({ ...validRequest, volume: 5, expiry: "2026-03-14" });

        expect(payload.volume).toBe(5 * GIGABYTE);
        expect(payload.expiry).toBeGreaterThan(0);
        expect(payload.name).toBe("alice");
    });

    it("leaves the credentials out when the form never held them", () => {
        // What is sent replaces what is stored, so an empty set would have the
        // API mint new credentials for every client application they have.
        expect(toClientPayload(validRequest)).not.toHaveProperty("config");
    });

    it("sends the credentials it held, less the ones left for the API to mint", () => {
        const payload = toClientPayload({
            ...validRequest,
            config: {
                vless: { name: "alice", uuid: "the-uuid", flow: "" },
                trojan: { password: "" },
            },
        });

        expect(payload.config).toEqual({ vless: { name: "alice", uuid: "the-uuid" } });
    });
});

describe("fromClient", () => {
    it("holds the credentials of a subscriber read on their own", () => {
        const config = { vless: { name: "alice", uuid: "the-uuid" } };

        expect(fromClient(buildClient({ config })).config).toEqual(config);
    });

    it("holds none for one from the listing, which leaves them out", () => {
        expect(fromClient(buildClient()).config).toBeUndefined();
    });
});

describe("withoutEmptyCredentials", () => {
    it("drops what is empty, and an identity with nothing left", () => {
        expect(
            withoutEmptyCredentials({
                tuic: { name: "alice", uuid: "", password: "kept" },
                hysteria: { auth_str: "" },
            }),
        ).toEqual({ tuic: { name: "alice", password: "kept" } });
    });
});

describe("withIdentityDrawn", () => {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    // A secret of 24 bytes, written URL-safe, as the API mints its own.
    const SECRET = /^[A-Za-z0-9_-]{32}$/;

    const config = {
        vless: { name: "alice", uuid: "the-uuid", flow: "xtls-rprx-vision" },
        trojan: { name: "alice", password: "secret" },
    };

    it("draws one identity afresh, and keeps what is chosen and what is not its own", () => {
        const drawn = withIdentityDrawn(config, "vless");

        // A flow is chosen rather than drawn, and the name is the API's to keep
        // in step.
        expect(drawn.vless).toMatchObject({ name: "alice", flow: "xtls-rprx-vision" });
        expect(drawn.vless.uuid).toMatch(UUID_V4);
        expect(drawn.trojan).toEqual({ name: "alice", password: "secret" });
    });

    it("draws every identity when none is named, the ones not held yet among them", () => {
        const drawn = withIdentityDrawn(config);

        expect(Object.keys(drawn).sort()).toEqual(IDENTITIES.map(({ key }) => key).sort());
        expect(drawn.trojan).toMatchObject({
            name: "alice",
            password: expect.stringMatching(SECRET),
        });
    });

    it("draws each credential the way the API mints its own", () => {
        const drawn = withIdentityDrawn({});
        const bytesIn = (key: unknown) => atob(String(key)).length;

        expect(drawn.vmess.uuid).toMatch(UUID_V4);
        expect(drawn.tuic).toEqual({
            password: expect.stringMatching(SECRET),
            uuid: expect.stringMatching(UUID_V4),
        });
        // A shadowsocks 2022 method reads a key of exactly its own size, and the
        // core refuses the whole configuration over any other.
        expect(bytesIn(drawn.shadowsocks.password)).toBe(32);
        expect(bytesIn(drawn.shadowsocks16.password)).toBe(16);
        expect(drawn.snell.userkey).toMatch(SECRET);
        expect(drawn.hysteria.auth_str).toMatch(SECRET);
        // Chosen rather than drawn, so a new one has none.
        expect(drawn.vless).not.toHaveProperty("flow");
    });

    it("draws something new every time", () => {
        expect(withIdentityDrawn(config).trojan.password).not.toBe(
            withIdentityDrawn(config).trojan.password,
        );
    });

    it("leaves an identity it does not know as it is", () => {
        expect(withIdentityDrawn({ wireguard: { private_key: "kept" } }).wireguard).toEqual({
            private_key: "kept",
        });
    });
});

describe("IDENTITIES", () => {
    it("names each identity once, each with something to hold", () => {
        const keys = IDENTITIES.map((identity) => identity.key);

        expect(new Set(keys).size).toBe(keys.length);
        expect(IDENTITIES.every((identity) => identity.fields.length > 0)).toBe(true);
    });
});

describe("usage", () => {
    it("counts the current period in both directions", () => {
        // The quota is held against the current period, not the lifetime total,
        // so a reset has to move the figure.
        const client = buildClient({ up: 100, down: 200, totalUp: 9_000, totalDown: 9_000 });

        expect(usedBytes(client)).toBe(300);
    });

    it("has no proportion to show for an unlimited subscriber", () => {
        expect(usedFraction(buildClient({ volume: 0, up: 500 }))).toBeNull();
    });

    it("never reports more than all of it", () => {
        // A subscriber can go over their quota before the worker notices, and a
        // meter past its maximum renders as an overflowing bar.
        const client = buildClient({ volume: 100, up: 300, down: 0 });

        expect(usedFraction(client)).toBe(1);
    });

    it("reports the fraction spent", () => {
        expect(usedFraction(buildClient({ volume: 100, up: 25, down: 0 }))).toBe(0.25);
    });
});

describe("quotaState", () => {
    it("tells a quota with no limit from one that is spent or still running", () => {
        expect(quotaState(buildClient({ volume: 0, up: 500 }))).toBe("unlimited");
        expect(quotaState(buildClient({ volume: 100, up: 60, down: 40 }))).toBe("spent");
        expect(quotaState(buildClient({ volume: 100, up: 10 }))).toBe("running");
    });
});

describe("quotaTone", () => {
    it("warns within the last tenth and turns once it is gone", () => {
        expect(quotaTone(buildClient({ volume: 100, up: 50 }))).toBe("success");
        expect(quotaTone(buildClient({ volume: 100, up: 91 }))).toBe("attention");
        expect(quotaTone(buildClient({ volume: 100, up: 100 }))).toBe("danger");
    });
});

describe("expiry", () => {
    const NOW = 1_800_000_000_000;
    const DAY = 86_400;

    it("reads a subscription with no expiry as never running out", () => {
        expect(expiryState(buildClient({ expiry: 0 }), NOW)).toBe("never");
    });

    it("reads a moment already past as expired", () => {
        expect(expiryState(buildClient({ expiry: NOW / 1000 - 1 }), NOW)).toBe("expired");
        expect(expiryState(buildClient({ expiry: NOW / 1000 + DAY }), NOW)).toBe("running");
    });

    it("counts whole days left, so the last day reads as none", () => {
        // The date and the hour are for the tooltip; the table says how many
        // days there are to go.
        expect(daysLeft(buildClient({ expiry: NOW / 1000 + 20.5 * DAY }), NOW)).toBe(20);
        expect(daysLeft(buildClient({ expiry: NOW / 1000 + 3_600 }), NOW)).toBe(0);
    });
});
