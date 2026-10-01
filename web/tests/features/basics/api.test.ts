import { describe, expect, it } from "vitest";

import {
    fromHttpClient,
    httpClientsOf,
    httpClientRequest,
    httpVersionName,
    intervalMinutes,
    isHttpClientsChanged,
    isNtpChanged,
    ntpOf,
    toHttpClient,
    withHttpClients,
    withNtp,
    type HttpClientRequest,
} from "@/features/basics/api";

const buildRequest = (overrides: Partial<HttpClientRequest> = {}): HttpClientRequest => ({
    tag: "downloads",
    version: "0",
    engine: "",
    detour: "",
    options: "",
    ...overrides,
});

describe("NTP and HTTP clients in the base document", () => {
    const config = {
        ntp: { enabled: true, server: "time.apple.com" },
        http_clients: [{ tag: "downloads", version: 2 }],
        log: { level: "info" },
    };

    it("reads each key on its own, including an absent or malformed key", () => {
        expect(ntpOf(config)).toEqual(config.ntp);
        expect(httpClientsOf(config)).toEqual(config.http_clients);
        expect(ntpOf(undefined)).toBeUndefined();
        expect(httpClientsOf(undefined)).toEqual([]);
        expect(ntpOf({ ntp: "on" })).toBeUndefined();
        expect(httpClientsOf({ http_clients: {} })).toEqual([]);
        expect(
            httpClientsOf({ http_clients: [{ version: 1 }, { tag: "downloads" }, "downloads"] }),
        ).toEqual([{ tag: "downloads" }]);
    });

    it("saves NTP without changing HTTP clients or other base keys", () => {
        expect(withNtp(config, { enabled: true, server: "time.example", interval: "" })).toEqual({
            ...config,
            ntp: { enabled: true, server: "time.example" },
        });
        expect(withNtp(config, undefined)).toEqual({
            http_clients: config.http_clients,
            log: config.log,
        });
    });

    it("saves HTTP clients without changing NTP or other base keys", () => {
        const client = { tag: "downloads", headers: { "User-Agent": "sing-box" } };
        expect(withHttpClients(config, [client])).toEqual({
            ...config,
            http_clients: [client],
        });
        expect(withHttpClients(config, [])).toEqual({ ntp: config.ntp, log: config.log });
    });

    it("cleans empty options without dropping an unknown nested option", () => {
        expect(
            withHttpClients(config, [
                { tag: "downloads", detour: "", tls: { server_name: "", insecure: true } },
            ]).http_clients,
        ).toEqual([{ tag: "downloads", tls: { insecure: true } }]);
    });

    it("tracks changes in each tab separately", () => {
        expect(isNtpChanged(config, ntpOf(config))).toBe(false);
        expect(isHttpClientsChanged(config, httpClientsOf(config))).toBe(false);
        expect(isNtpChanged(config, undefined)).toBe(true);
        expect(isNtpChanged(config, { ...config.ntp, interval: "" })).toBe(false);
        expect(isHttpClientsChanged(config, [{ tag: "another" }])).toBe(true);
    });
});

describe("intervalMinutes", () => {
    it("reads minutes and whole hours as minutes", () => {
        expect(intervalMinutes("30m")).toBe(30);
        expect(intervalMinutes("2h")).toBe(120);
    });

    it("gives nothing for an interval in any other shape", () => {
        expect(intervalMinutes("1h30m")).toBeNull();
        expect(intervalMinutes("90s")).toBeNull();
        expect(intervalMinutes(30)).toBeNull();
        expect(intervalMinutes(undefined)).toBeNull();
    });
});

describe("httpVersionName", () => {
    it("names a version as the reference does, and none as Auto", () => {
        expect(httpVersionName(2)).toBe("HTTP/2");
        expect(httpVersionName(undefined)).toBe("Auto");
    });

    it("shows a version it does not know as it was written", () => {
        expect(httpVersionName(4)).toBe("4");
    });
});

describe("httpClientRequest", () => {
    it("accepts a client with nothing but a tag", () => {
        expect(httpClientRequest.safeParse(buildRequest()).success).toBe(true);
    });

    it("refuses a tag that is empty or has spaces in it", () => {
        expect(httpClientRequest.safeParse(buildRequest({ tag: "" })).success).toBe(false);
        expect(httpClientRequest.safeParse(buildRequest({ tag: "rule sets" })).success).toBe(false);
    });

    it("refuses options that are not a JSON object", () => {
        expect(httpClientRequest.safeParse(buildRequest({ options: "[]" })).success).toBe(false);
        expect(httpClientRequest.safeParse(buildRequest({ options: "{" })).success).toBe(false);
        expect(
            httpClientRequest.safeParse(buildRequest({ options: '{"headers": {}}' })).success,
        ).toBe(true);
    });
});

describe("toHttpClient", () => {
    it("writes only what was chosen", () => {
        // Auto, the default engine and no detour are the keys left out.
        expect(toHttpClient(buildRequest())).toEqual({ tag: "downloads" });
        expect(
            toHttpClient(buildRequest({ version: "3", engine: "go", detour: "upstream" })),
        ).toEqual({ tag: "downloads", version: 3, engine: "go", detour: "upstream" });
    });

    it("adds the options, but not over the fields that have their own", () => {
        expect(
            toHttpClient(
                buildRequest({
                    detour: "upstream",
                    options: '{"headers": {"User-Agent": "sing-box"}, "detour": "direct"}',
                }),
            ),
        ).toEqual({ tag: "downloads", detour: "upstream", headers: { "User-Agent": "sing-box" } });
    });

    it("gives back what fromHttpClient read", () => {
        const client = {
            tag: "downloads",
            version: 2,
            engine: "apple",
            detour: "upstream",
            disable_version_fallback: true,
        };

        expect(toHttpClient(fromHttpClient(client))).toEqual(client);
    });
});

describe("fromHttpClient", () => {
    it("fills the form with a client, and its other options as a document", () => {
        expect(fromHttpClient({ tag: "downloads", headers: { Accept: "*/*" } })).toEqual({
            tag: "downloads",
            version: "0",
            engine: "",
            detour: "",
            options: JSON.stringify({ headers: { Accept: "*/*" } }, null, 4),
        });
    });
});
