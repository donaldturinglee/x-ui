import useSWR, { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import { create } from "zustand";

import { request, RequestError } from "@/lib/request";
import { settings } from "@/settings";

import type { UpgradeRelease } from "./upgrade";

export interface CoreVersionJob {
    id: string;
    state: "queued" | "running" | "rolling_back" | "succeeded" | "rolled_back" | "failed";
    phase: string;
    direction: "upgrade" | "downgrade";
    actor: string;
    fromVersion: string;
    toVersion: string;
    requestedAt: string;
    finishedAt?: string;
    error?: string;
    needsRecovery: boolean;
}

export interface CoreVersionStatus {
    supported: boolean;
    reason?: string;
    currentVersion: string;
    packageVersion: string;
    platform: string;
    manager: string;
    configRevision: string;
    versions: UpgradeRelease[];
    checkedAt?: string;
    checkError?: string;
    blockedReason?: string;
    job?: CoreVersionJob;
}

export interface CoreVersionCheck {
    checkId: string;
    checkedAt: string;
    currentVersion: string;
    configRevision: string;
    direction: "upgrade" | "downgrade";
    target: UpgradeRelease;
}

export interface CoreVersionRequest {
    checkId: string;
    expectedCurrentVersion: string;
    configRevision: string;
}

export const isCoreVersionActive = (job?: CoreVersionJob | null) =>
    Boolean(job && ["queued", "running", "rolling_back"].includes(job.state));

export const coreVersionMessage = (job?: CoreVersionJob | null) => {
    if (!job) return "";
    if (job.needsRecovery && job.state === "failed")
        return "sing-box version change requires recovery";
    if (job.state === "succeeded") return `sing-box changed to ${job.toVersion}`;
    if (job.state === "rolled_back") return `Restored sing-box ${job.fromVersion}`;
    if (job.state === "failed") return "sing-box version change failed";
    if (job.state === "rolling_back") return "Restoring the previous sing-box package and state";
    const phases: Record<string, string> = {
        scheduled: "Version change scheduled",
        downloading: "Downloading and verifying target and recovery packages",
        checking: "Checking configuration and native API compatibility",
        stopping: "Stopping sing-box",
        backing_up: "Backing up the local configuration and state",
        installing: "Installing the selected sing-box package",
        restarting: "Starting sing-box",
        verifying: "Checking the running version and native statistics API",
    };
    return phases[job.phase] ?? "sing-box version change in progress";
};

const storageKey = `x-ui-core-version-job:${settings.baseURL}`;
const rememberedJob = () => {
    try {
        const id = localStorage.getItem(storageKey);
        return id && /^[a-f0-9]{32}$/.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
};

export const useCoreVersionTracking = create<{ id?: string; track: (id: string) => void }>(
    (set) => ({
        id: rememberedJob(),
        track: (id) => {
            try {
                localStorage.setItem(storageKey, id);
            } catch {
                // The server also persists the current task.
            }
            set({ id });
        },
    }),
);

export const useCoreVersions = () =>
    useSWR<CoreVersionStatus, Error>("/core/versions", () => request.get("/core/versions"), {
        refreshInterval: 5000,
    });

export const useRefreshCoreVersions = () =>
    useSWRMutation(
        "/core/versions?refresh=true",
        (key: string) => request.get<CoreVersionStatus>(key),
        {
            throwOnError: false,
            onSuccess: (state) => void mutate("/core/versions", state, false),
        },
    );

export const useCheckCoreVersion = () =>
    useSWRMutation(
        "/core/version/check",
        (key: string, { arg }: { arg: { version: string } }) =>
            request.post<CoreVersionCheck>(key, arg),
        { throwOnError: false },
    );

export const useStartCoreVersion = () =>
    useSWRMutation(
        "/core/version",
        (key: string, { arg }: { arg: CoreVersionRequest }) =>
            request.post<CoreVersionJob>(key, arg),
        {
            throwOnError: false,
            onSuccess: (job) => {
                useCoreVersionTracking.getState().track(job.id);
                void mutate<CoreVersionStatus>(
                    "/core/versions",
                    (state) => state && { ...state, job },
                    false,
                );
            },
        },
    );

export const useCoreVersionJob = (id?: string) =>
    useSWR<CoreVersionJob, Error>(
        id ? `/core/version/jobs/${id}` : null,
        (key: string) => request.get<CoreVersionJob>(key),
        {
            refreshInterval: (job) =>
                isCoreVersionActive(job) ? 1000 : job?.needsRecovery ? 5000 : 0,
            errorRetryInterval: 1500,
            shouldRetryOnError: (error) => !(error instanceof RequestError && error.status === 401),
            onSuccess: (job) => {
                if (!isCoreVersionActive(job)) {
                    void mutate("/core");
                    void mutate("/core/versions");
                }
            },
        },
    );
