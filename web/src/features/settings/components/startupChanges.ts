import type { PanelSettings, SettingsScope } from "../api/panel";
import type { SubscriptionSettings } from "../api/subscription";

export interface SettingsChange {
    scope: string;
    label: string;
    before: string;
    after: string;
}

const PANEL_LABELS: Record<keyof PanelSettings, string> = {
    listen: "Address",
    port: "Port",
    basePath: "Web path",
    domain: "Domain",
    certFile: "SSL certificate path",
    keyFile: "SSL key path",
    trustedProxies: "Trusted proxies",
    maxAgeSeconds: "Session length (seconds)",
    statsRetentionSeconds: "Traffic retention (seconds)",
    statsBucketSeconds: "Traffic bucket (seconds)",
    timeLocation: "Time zone",
    resetSpec: "Global traffic reset",
    depleteSpec: "Quota enforcement",
    cleanupSpec: "Retention cleanup",
    logLevel: "Log level",
};
const SUBSCRIPTION_LABELS: Record<keyof SubscriptionSettings, string> = {
    enabled: "Enable subscriptions",
    listen: "Address",
    port: "Port",
    basePath: "Path",
    domain: "Domain",
    certFile: "SSL certificate path",
    keyFile: "SSL key path",
    publicUrl: "Public URL",
    trustedProxies: "Trusted proxies",
};
const displayValue = (value: unknown) =>
    typeof value === "boolean"
        ? value
            ? "On"
            : "Off"
        : Array.isArray(value)
          ? value.join(", ") || "None"
          : String(value || "Not set");
const changes = <T extends object>(
    scope: string,
    saved: T,
    running: T,
    labels: Record<keyof T, string>,
): SettingsChange[] =>
    (Object.keys(labels) as (keyof T)[])
        .filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(running[key]))
        .map((key) => ({
            scope,
            label: labels[key],
            before: displayValue(running[key]),
            after: displayValue(saved[key]),
        }));

export const startupChanges = (
    scopes: SettingsScope[],
    savedPanel: PanelSettings,
    runningPanel: PanelSettings,
    savedSubscription?: SubscriptionSettings,
    runningSubscription?: SubscriptionSettings,
): SettingsChange[] => [
    ...(scopes.includes("panel") ? changes("Panel", savedPanel, runningPanel, PANEL_LABELS) : []),
    ...(scopes.includes("subscription") && savedSubscription && runningSubscription
        ? changes("Subscription", savedSubscription, runningSubscription, SUBSCRIPTION_LABELS)
        : []),
];
