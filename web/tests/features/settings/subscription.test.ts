import { describe, expect, it } from "vitest";

import {
    fromSubscriptionSettings,
    subscriptionPublicBase,
    subscriptionSettingsRequest,
    type SubscriptionSettings,
} from "@/features/settings/api/subscription";
import { panelAccessUrl } from "@/features/settings/api/panel";
import { startupChanges } from "@/features/settings/components/startupChanges";
import { defaultPanelSettings } from "../../../e2e/fixtures/api";

const settings: SubscriptionSettings = {
    enabled: true,
    listen: "",
    port: 8443,
    basePath: "/sub/",
    domain: "",
    certFile: "",
    keyFile: "",
    publicUrl: "",
    trustedProxies: [],
};

describe("Subscription service settings", () => {
    it("normalizes a proxy prefix and derives a separate subscription URI", () => {
        const values = subscriptionSettingsRequest.parse({
            ...fromSubscriptionSettings(settings),
            basePath: "nested/sub",
            publicUrl: " https://sub.example/proxy/ ",
            trustedProxies: "127.0.0.1, 10.0.0.0/8, ",
        });
        expect(values.trustedProxies).toEqual(["127.0.0.1", "10.0.0.0/8"]);
        expect(subscriptionPublicBase(values, "panel.example")).toBe(
            "https://sub.example/proxy/nested/sub/",
        );
        expect(subscriptionPublicBase(settings, "panel.example")).toBe(
            "http://panel.example:8443/sub/",
        );
        expect(
            subscriptionPublicBase(
                { ...settings, port: 443, certFile: "cert.pem", keyFile: "key.pem" },
                "::1",
            ),
        ).toBe("https://[::1]/sub/");
    });
    it.each([
        { port: "" },
        { port: "1.5" },
        { port: "65536" },
        { basePath: "../sub" },
        { basePath: "/sub/./" },
        { domain: "https://sub.example" },
        { certFile: "cert.pem" },
        { publicUrl: "ftp://sub.example" },
        { publicUrl: "https://user:password@sub.example" },
        { publicUrl: "https://sub.example?token=x" },
        { publicUrl: "https://sub.example#fragment" },
    ])("rejects invalid draft %j", (changes) => {
        expect(
            subscriptionSettingsRequest.safeParse({
                ...fromSubscriptionSettings(settings),
                ...changes,
            }).success,
        ).toBe(false);
    });
    it("lists changes from both pages and preserves the active tab when the panel moves", () => {
        const panel = { ...defaultPanelSettings, port: 9000, basePath: "/control/" };
        const sub = { ...settings, enabled: false, port: 9443 };
        const rows = startupChanges(
            ["panel", "subscription"],
            panel,
            defaultPanelSettings,
            sub,
            settings,
        );
        expect(rows.map(({ scope, label }) => `${scope}: ${label}`)).toEqual([
            "Panel: Port",
            "Panel: Web path",
            "Subscription: Enable subscriptions",
            "Subscription: Port",
        ]);
        expect(rows.find(({ label }) => label === "Enable subscriptions")?.after).toBe("Off");
        expect(
            panelAccessUrl(
                panel,
                defaultPanelSettings,
                "https://panel.example/general/settings?tab=subscription",
                "subscription",
            ),
        ).toBe("https://panel.example:9000/control/general/settings?tab=subscription");
    });
});
