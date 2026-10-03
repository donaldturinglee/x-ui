import useSWR from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { request } from "@/lib/request";
import type { PanelRestartJob, PanelSettings, SettingsScope } from "./panel";

export interface SubscriptionSettings {
    enabled: boolean;
    listen: string;
    port: number;
    basePath: string;
    domain: string;
    certFile: string;
    keyFile: string;
    publicUrl: string;
    trustedProxies: string[];
}

export interface SubscriptionSettingsState {
    saved: SubscriptionSettings;
    running: SubscriptionSettings;
    savedPanel: PanelSettings;
    runningPanel: PanelSettings;
    revision: string;
    overrides: Partial<Record<keyof SubscriptionSettings, string>>;
    pendingScopes: SettingsScope[];
    restartRequired: boolean;
    restartSupported: boolean;
    restartUnavailableReason?: string;
    restartJob?: PanelRestartJob;
    savedUri: string;
    runningUri: string;
}

export const subscriptionSettingsRequest = z
    .object({
        enabled: z.boolean(),
        listen: z.string().trim(),
        port: z
            .string()
            .trim()
            .regex(/^\d+$/, "Port must be a whole number between 1 and 65535.")
            .transform(Number)
            .pipe(z.number().int().min(1).max(65535)),
        basePath: z
            .string()
            .trim()
            .min(1, "Enter a subscription path, such as /sub/.")
            .transform((raw) => {
                const path = raw.replace(/^\/+|\/+$/g, "");
                return path ? `/${path}/` : "/";
            })
            .refine(
                (path) =>
                    /^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(path) &&
                    !path.split("/").some((part) => part === "." || part === ".."),
                "Path must use slash-separated names without . or .. segments.",
            ),
        domain: z
            .string()
            .trim()
            .refine(
                (value) => !/[/\\?#\s:]/.test(value),
                "Domain must be a host name without a scheme, port or path.",
            ),
        certFile: z.string().trim(),
        keyFile: z.string().trim(),
        publicUrl: z
            .string()
            .trim()
            .transform((raw) => raw.replace(/\/+$/, ""))
            .refine((raw) => {
                if (!raw) return true;
                try {
                    const url = new URL(raw);
                    return (
                        ["http:", "https:"].includes(url.protocol) &&
                        Boolean(url.hostname) &&
                        !url.username &&
                        !url.password &&
                        !raw.includes("?") &&
                        !raw.includes("#") &&
                        !/[\\\s]/.test(raw) &&
                        (!url.port || Number(url.port) > 0)
                    );
                } catch {
                    return false;
                }
            }, "Public URL must be an HTTP or HTTPS base address without credentials, query or fragment."),
        trustedProxies: z.string().transform((raw) =>
            raw
                .split(",")
                .map((proxy) => proxy.trim())
                .filter(Boolean),
        ),
    })
    .refine(({ certFile, keyFile }) => Boolean(certFile) === Boolean(keyFile), {
        message: "Set both SSL certificate and key paths, or leave both empty.",
        path: ["certFile"],
    });

export type SubscriptionServiceForm = z.input<typeof subscriptionSettingsRequest>;
export const fromSubscriptionSettings = (
    values: SubscriptionSettings,
): SubscriptionServiceForm => ({
    ...values,
    port: String(values.port),
    trustedProxies: values.trustedProxies.join(", "),
});

export { subscriptionPublicBase } from "../subscriptionUri";

export const SUBSCRIPTION_SETTINGS_KEY = "/settings/subscription";
export const useSubscriptionSettings = () =>
    useSWR<SubscriptionSettingsState, Error>(SUBSCRIPTION_SETTINGS_KEY, () =>
        request.get<SubscriptionSettingsState>(SUBSCRIPTION_SETTINGS_KEY),
    );
export const useSaveSubscriptionSettings = () =>
    useSWRMutation(
        SUBSCRIPTION_SETTINGS_KEY,
        (_key: string, { arg }: { arg: { revision: string; values: SubscriptionSettings } }) =>
            request.post<SubscriptionSettingsState>(SUBSCRIPTION_SETTINGS_KEY, arg),
        { throwOnError: false, populateCache: true, revalidate: false },
    );
