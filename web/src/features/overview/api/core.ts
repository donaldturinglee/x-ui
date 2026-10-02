import useSWR from "swr";
import useSWRMutation from "swr/mutation";

import { request, RequestError } from "@/lib/request";

export interface CoreRestartJob {
    id: string;
    state: "queued" | "checking" | "restarting" | "verifying" | "succeeded" | "failed";
    actor: string;
    requestedAt: string;
    finishedAt?: string;
    beforePid: number;
    afterPid: number;
    error?: string;
}

export interface CoreStatus {
    supported: boolean;
    reason?: string;
    state: string;
    pid: number;
    uptimeSeconds: number;
    restartJob?: CoreRestartJob;
}

export const isCoreRestartActive = (job?: CoreRestartJob | null) =>
    Boolean(job && ["queued", "checking", "restarting", "verifying"].includes(job.state));

export const coreRestartMessage = (job?: CoreRestartJob | null) => {
    switch (job?.state) {
        case "queued":
            return "Restart scheduled";
        case "checking":
            return "Checking configuration";
        case "restarting":
            return "Restarting sing-box";
        case "verifying":
            return "Checking the new core process";
        case "succeeded":
            return "sing-box restarted successfully";
        case "failed":
            return "Restart failed. View logs for details.";
        default:
            return "";
    }
};

export const useCoreStatus = () =>
    useSWR<CoreStatus, Error>("/core", () => request.get<CoreStatus>("/core"), {
        refreshInterval: 5000,
    });

export const useRestartCore = () =>
    useSWRMutation("/core/restart", (key: string) => request.post<CoreRestartJob>(key, {}), {
        throwOnError: false,
    });

export const useCoreRestartJob = (id: string | undefined, onFinished: () => void) =>
    useSWR<CoreRestartJob, Error>(
        id ? `/core/restart/${id}` : null,
        (key: string) => request.get<CoreRestartJob>(key),
        {
            refreshInterval: (job) => (isCoreRestartActive(job) ? 1000 : 0),
            dedupingInterval: 250,
            revalidateOnFocus: false,
            errorRetryInterval: 1500,
            errorRetryCount: 80,
            shouldRetryOnError: (error) => !(error instanceof RequestError && error.status === 401),
            onSuccess: (job) => {
                if (!isCoreRestartActive(job)) onFinished();
            },
        },
    );

export const useCoreLogs = () =>
    useSWR<{ lines: string[] }, Error>("/core/logs", () =>
        request.get<{ lines: string[] }>("/core/logs"),
    );
