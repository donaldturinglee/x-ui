import { describe, expect, it } from "vitest";

import {
    fromPanelSettings,
    panelAccessUrl,
    panelSettingsRequest,
    type PanelSettings,
} from "@/features/settings/api/panel";

const settings: PanelSettings = {
    listen: "",
    port: 8000,
    basePath: "/",
    domain: "",
    keyFile: "",
    certFile: "",
    trustedProxies: [],
    maxAgeSeconds: 1,
    statsRetentionSeconds: 1,
    statsBucketSeconds: 60,
    timeLocation: "UTC",
    resetSpec: "",
    depleteSpec: "@every 1m",
    cleanupSpec: "@daily",
    logLevel: "info",
};

describe("Panel settings payload", () => {
    it("round-trips durations without rounding away seconds", () => {
        expect(panelSettingsRequest.parse(fromPanelSettings(settings))).toEqual(settings);
    });
    it("normalises Off, proxy lists and a nested Web path", () => {
        const payload = panelSettingsRequest.parse({
            ...fromPanelSettings(settings),
            basePath: "control/nested",
            resetSpec: " Off ",
            trustedProxies: " 127.0.0.1, 10.0.0.0/8, ",
            maxAgeSeconds: "1.5",
            statsRetentionSeconds: "1.5",
        });
        expect(payload.basePath).toBe("/control/nested/");
        expect(payload.resetSpec).toBe("");
        expect(payload.trustedProxies).toEqual(["127.0.0.1", "10.0.0.0/8"]);
        expect(payload.maxAgeSeconds).toBe(90);
        expect(payload.statsRetentionSeconds).toBe(129_600);
    });
    it("refuses empty numbers, duration overflow, unsafe paths and incomplete TLS", () => {
        for (const changes of [
            { port: "" },
            { port: "65536" },
            { statsBucketSeconds: "0" },
            { statsRetentionSeconds: "999999999" },
            { basePath: "/../control/" },
            { domain: "https://panel.example" },
            { keyFile: "/etc/key.pem" },
        ]) {
            expect(
                panelSettingsRequest.safeParse({ ...fromPanelSettings(settings), ...changes })
                    .success,
            ).toBe(false);
        }
    });
});

describe("Panel restart access address", () => {
    it("preserves the public reverse-proxy URL for unrelated settings", () => {
        const current = "https://panel.example/control/general/settings?tab=panel";
        expect(panelAccessUrl({ ...settings, logLevel: "warning" }, settings, current)).toBe(
            current,
        );
    });
    it("uses the changed port and Web path without directing the browser to a listen address", () => {
        expect(
            panelAccessUrl(
                { ...settings, listen: "0.0.0.0", port: 9000, basePath: "/control/" },
                settings,
                "http://public.example:8000/general/settings?tab=panel",
            ),
        ).toBe("http://public.example:9000/control/general/settings?tab=panel");
    });
    it("retains an explicit listener port when enabling HTTPS on port 80", () => {
        const previous = { ...settings, port: 80 };
        expect(
            panelAccessUrl(
                { ...previous, certFile: "cert.pem", keyFile: "key.pem" },
                previous,
                "http://panel.example/general/settings?tab=panel",
            ),
        ).toBe("https://panel.example:80/general/settings?tab=panel");
    });
});
