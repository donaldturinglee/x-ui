import useSWR from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { request, RequestError } from "@/lib/request";
import type { SubscriptionSettings } from "./subscription";

export type SettingsScope = "panel" | "subscription";

export interface PanelSettings {
    listen: string;
    port: number;
    basePath: string;
    domain: string;
    keyFile: string;
    certFile: string;
    trustedProxies: string[];
    maxAgeSeconds: number;
    statsRetentionSeconds: number;
    statsBucketSeconds: number;
    timeLocation: string;
    resetSpec: string;
    depleteSpec: string;
    cleanupSpec: string;
    logLevel: string;
}

export interface PanelSettingsState {
    saved: PanelSettings;
    running: PanelSettings;
    revision: string;
    overrides: Partial<Record<keyof PanelSettings, string>>;
    restartRequired: boolean;
    restartSupported?: boolean;
    restartUnavailableReason?: string;
    restartJob?: PanelRestartJob;
    pendingScopes?: SettingsScope[];
    savedSubscription?: SubscriptionSettings;
    runningSubscription?: SubscriptionSettings;
}

export interface PanelRestartJob {
    id: string;
    state: "queued" | "running" | "rolling_back" | "succeeded" | "rolled_back" | "failed";
    revision: string;
    actor: string;
    requestedAt: string;
    finishedAt?: string;
    values: PanelSettings;
    previous: PanelSettings;
    subscription?: SubscriptionSettings;
    previousSubscription?: SubscriptionSettings;
    scopes?: SettingsScope[];
    error?: string;
}

export const isPanelRestartActive = (job?: PanelRestartJob | null) =>
    Boolean(job && ["queued", "running", "rolling_back"].includes(job.state));

// Preserve the browser's public host and protocol behind a reverse proxy.
// Only changes to the corresponding listener fields alter the candidate URL.
export const panelAccessUrl = (
    values: PanelSettings,
    previous: PanelSettings,
    current: string,
    tab = "panel",
) => {
    const url = new URL(current);
    if (values.domain !== previous.domain && values.domain) url.hostname = values.domain;
    const tlsChanged =
        Boolean(values.certFile && values.keyFile) !==
        Boolean(previous.certFile && previous.keyFile);
    if (tlsChanged) url.protocol = values.certFile && values.keyFile ? "https:" : "http:";
    if (values.port !== previous.port || tlsChanged) url.port = String(values.port);
    if (values.basePath !== previous.basePath) {
        url.pathname = `${values.basePath}general/settings`;
        url.search = `?tab=${tab}`;
    }
    return url.href;
};

export const PANEL_LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical"];

// The draft keeps text, including cleared numbers. Durations displayed in
// minutes/days are converted to whole seconds only for a valid save request.
const duration = (unit: number, minimum: number, label: string) =>
    z
        .string()
        .trim()
        .refine(
            (raw) => {
                const seconds = Number(raw) * unit;
                return (
                    raw !== "" &&
                    Number.isFinite(seconds) &&
                    seconds >= minimum &&
                    seconds <= 9_223_372_036 &&
                    Math.abs(seconds - Math.round(seconds)) < 0.000001
                );
            },
            `${label} must be ${minimum ? "positive" : "non-negative"} and resolve to whole seconds.`,
        )
        .transform((raw) => Math.round(Number(raw) * unit));

const schedule = z
    .string()
    .trim()
    .transform((spec) => (spec.toLowerCase() === "off" ? "" : spec));

export const panelSettingsRequest = z
    .object({
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
            .min(1, "Enter a Web path, such as / or /panel/.")
            .transform((value) => {
                const path = value.replace(/^\/+|\/+$/g, "");
                return path ? `/${path}/` : "/";
            })
            .pipe(
                z
                    .string()
                    .regex(
                        /^\/(?:[A-Za-z0-9_-]+\/)*$/,
                        "Web path must use slash-separated names with letters, numbers, - and _.",
                    ),
            ),
        domain: z
            .string()
            .trim()
            .refine(
                (value) => !/[/\\?#\s:]/.test(value),
                "Domain must be a host name without a scheme, port or path.",
            ),
        keyFile: z.string().trim(),
        certFile: z.string().trim(),
        trustedProxies: z.string().transform((raw) =>
            raw
                .split(",")
                .map((proxy) => proxy.trim())
                .filter(Boolean),
        ),
        maxAgeSeconds: duration(60, 0, "Session length"),
        statsRetentionSeconds: duration(86_400, 0, "Traffic retention"),
        statsBucketSeconds: duration(1, 1, "Traffic bucket"),
        timeLocation: z.string().trim().min(1, "Enter a time zone."),
        resetSpec: schedule,
        depleteSpec: schedule,
        cleanupSpec: schedule,
        logLevel: z
            .string()
            .refine((level) => PANEL_LOG_LEVELS.includes(level), "Choose a log level."),
    })
    .refine(({ keyFile, certFile }) => Boolean(keyFile) === Boolean(certFile), {
        message: "Set both SSL certificate and key paths, or leave both empty.",
        path: ["certFile"],
    });

export type PanelForm = z.input<typeof panelSettingsRequest>;

export const fromPanelSettings = (values: PanelSettings): PanelForm => ({
    ...values,
    port: String(values.port),
    trustedProxies: values.trustedProxies.join(", "),
    maxAgeSeconds: String(values.maxAgeSeconds / 60),
    statsRetentionSeconds: String(values.statsRetentionSeconds / 86_400),
    statsBucketSeconds: String(values.statsBucketSeconds),
});

export const PANEL_SETTINGS_KEY = "/settings/panel";

export const usePanelSettings = () =>
    useSWR<PanelSettingsState, Error>(PANEL_SETTINGS_KEY, () =>
        request.get<PanelSettingsState>(PANEL_SETTINGS_KEY),
    );

export const useSavePanelSettings = () =>
    useSWRMutation(
        PANEL_SETTINGS_KEY,
        (_key: string, { arg }: { arg: { revision: string; values: PanelSettings } }) =>
            request.post<PanelSettingsState>(PANEL_SETTINGS_KEY, arg),
        { throwOnError: false, populateCache: true, revalidate: false },
    );

export const useRestartPanelSettings = () =>
    useSWRMutation(
        "/settings/apply",
        (key: string, { arg }: { arg: { revision: string; scopes: SettingsScope[] } }) =>
            request.post<PanelRestartJob>(key, arg),
        { throwOnError: false },
    );

export const usePanelRestartJob = (id: string | undefined, onFinished: () => void) =>
    useSWR<PanelRestartJob, Error>(
        id ? `/settings/apply/${id}` : null,
        (key: string) => request.get<PanelRestartJob>(key),
        {
            refreshInterval: (job) => (isPanelRestartActive(job) ? 1500 : 0),
            revalidateOnFocus: false,
            errorRetryInterval: 1500,
            errorRetryCount: 80,
            shouldRetryOnError: (error) => !(error instanceof RequestError && error.status === 401),
            onSuccess: (job) => {
                if (!isPanelRestartActive(job)) onFinished();
            },
        },
    );
