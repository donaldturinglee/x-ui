import { create } from "zustand";
import useSWR, { mutate } from "swr";
import useSWRMutation from "swr/mutation";

import { request, RequestError } from "@/lib/request";
import { settings } from "@/settings";

export interface UpgradeRelease {
    id: number;
    version: string;
    url: string;
    publishedAt: string;
    assetId: number;
    assetName: string;
    assetUrl: string;
    assetSize: number;
    assetUpdatedAt: string;
    sha256: string;
}

export interface UpgradeJob {
    id: string;
    state: "queued" | "running" | "rolling_back" | "succeeded" | "rolled_back" | "failed";
    phase: string;
    actor: string;
    fromVersion: string;
    toVersion: string;
    components: string[];
    requestedAt: string;
    finishedAt?: string;
    error?: string;
    needsRecovery: boolean;
}

export interface UpgradeStatus {
    supported: boolean;
    reason?: string;
    currentVersion: string;
    platform: string;
    checkState: "unchecked" | "checked" | "failed" | "expired";
    checkedAt?: string;
    checkError?: string;
    checkId?: string;
    configRevision: string;
    latest?: UpgradeRelease;
    canUpgrade: boolean;
    blockedReason?: string;
    components: string[];
    job?: UpgradeJob;
}

export interface UpgradeRequest {
    checkId: string;
    expectedCurrentVersion: string;
    configRevision: string;
}

const storageKey = `x-ui-upgrade-job:${settings.baseURL}`;
const rememberedJob = () => {
    try {
        const id = localStorage.getItem(storageKey);
        return id && /^[a-f0-9]{32}$/.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
};

export const useUpgradeTracking = create<{ id?: string; track: (id: string) => void }>((set) => ({
    id: rememberedJob(),
    track: (id) => {
        try {
            localStorage.setItem(storageKey, id);
        } catch {
            // The backend still remembers the task if browser storage is unavailable.
        }
        set({ id });
    },
}));

export const isUpgradeActive = (job?: UpgradeJob | null) =>
    Boolean(job && ["queued", "running", "rolling_back"].includes(job.state));

export const upgradeMessage = (job?: UpgradeJob) => {
    if (!job) return "";
    if (job.state === "succeeded") return `Upgraded to ${job.toVersion}`;
    if (job.state === "rolled_back") return `Upgrade rolled back to ${job.fromVersion}`;
    if (job.state === "failed")
        return job.needsRecovery ? "Upgrade requires recovery" : "Upgrade failed";
    if (job.state === "rolling_back") return "Restoring the previous version and database";
    const messages: Record<string, string> = {
        scheduled: "Upgrade scheduled",
        downloading: "Downloading and verifying the release",
        checking: "Checking the installation",
        backing_up: "Backing up the installation",
        stopping: "Stopping services and backing up the database",
        migrating: "Applying database migrations",
        installing: "Installing the new version",
        restarting: "Starting services",
        verifying: "Checking the new version and services",
        recovering: "Restoring the previous installation",
    };
    return messages[job.phase] ?? "Upgrade in progress";
};

const retry = (error: Error) => !(error instanceof RequestError && error.status === 401);

export const useUpgradeStatus = () =>
    useSWR<UpgradeStatus, Error>("/upgrade", () => request.get<UpgradeStatus>("/upgrade"), {
        refreshInterval: (status) => (isUpgradeActive(status?.job) ? 2000 : 15000),
        errorRetryInterval: 2000,
        errorRetryCount: 80,
        shouldRetryOnError: retry,
    });

export const useCheckUpgrade = () =>
    useSWRMutation("/upgrade/check", (key: string) => request.post<UpgradeStatus>(key, {}), {
        throwOnError: false,
        onSuccess: (status) => void mutate("/upgrade", status, false),
    });

export const useStartUpgrade = () =>
    useSWRMutation(
        "/upgrade",
        (key: string, { arg }: { arg: UpgradeRequest }) => request.post<UpgradeJob>(key, arg),
        {
            throwOnError: false,
            onSuccess: (job) => {
                useUpgradeTracking.getState().track(job.id);
                void mutate<UpgradeStatus>(
                    "/upgrade",
                    (status) => status && { ...status, job, canUpgrade: false },
                    false,
                );
            },
        },
    );

export const useUpgradeJob = (id?: string) =>
    useSWR<UpgradeJob, Error>(
        id ? `/upgrade/jobs/${id}` : null,
        (key: string) => request.get<UpgradeJob>(key),
        {
            refreshInterval: (job) => (isUpgradeActive(job) ? 1000 : 0),
            dedupingInterval: 250,
            revalidateOnFocus: false,
            errorRetryInterval: 1500,
            errorRetryCount: 80,
            shouldRetryOnError: retry,
            onSuccess: (job) => {
                if (!isUpgradeActive(job)) void mutate("/upgrade");
            },
        },
    );
