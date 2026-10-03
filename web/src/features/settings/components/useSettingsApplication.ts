import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";

import {
    isPanelRestartActive,
    panelAccessUrl,
    usePanelRestartJob,
    useRestartPanelSettings,
    PANEL_SETTINGS_KEY,
    type PanelRestartJob,
    type PanelSettings,
    type SettingsScope,
} from "../api/panel";
import { SUBSCRIPTION_SETTINGS_KEY } from "../api/subscription";
import { STARTUP_SETTINGS_KEY } from "../api";
import { SUBSCRIPTION_URI_KEY } from "@/features/clients/api";

export interface SettingsApplicationState {
    revision: string;
    savedPanel: PanelSettings;
    runningPanel: PanelSettings;
    pendingScopes?: SettingsScope[];
    restartRequired: boolean;
    restartJob?: PanelRestartJob;
}

export const useSettingsApplication = (
    data: SettingsApplicationState | undefined,
    tab: SettingsScope,
) => {
    const { mutate } = useSWRConfig();
    const refreshSettings = () =>
        Promise.all([
            mutate(PANEL_SETTINGS_KEY),
            mutate(SUBSCRIPTION_SETTINGS_KEY),
            mutate(STARTUP_SETTINGS_KEY),
            mutate(SUBSCRIPTION_URI_KEY),
        ]);
    const [submittedJob, setSubmittedJob] = useState<PanelRestartJob | null>(null);
    const [timedOutJob, setTimedOutJob] = useState<string | null>(null);
    const {
        trigger: restart,
        isMutating: isScheduling,
        error: restartError,
    } = useRestartPanelSettings();
    const followedJob =
        submittedJob &&
        (!data?.restartJob ||
            Date.parse(submittedJob.requestedAt) > Date.parse(data.restartJob.requestedAt))
            ? submittedJob
            : data?.restartJob;
    const { data: polledJob, error: reconnectError } = usePanelRestartJob(followedJob?.id, () => {
        void refreshSettings();
    });
    const job = polledJob ?? followedJob;
    const isRestarting = isScheduling || isPanelRestartActive(job);
    const targetUrl = data
        ? panelAccessUrl(data.savedPanel, data.runningPanel, window.location.href, tab)
        : window.location.href;
    const jobUrl = job
        ? panelAccessUrl(job.values, job.previous, window.location.href, tab)
        : targetUrl;
    const connectionTimedOut = Boolean(job && reconnectError && timedOutJob === job.id);
    useEffect(() => {
        if (!job || !isPanelRestartActive(job)) return;
        const timer = window.setTimeout(
            () => setTimedOutJob(job.id),
            Math.max(0, Date.parse(job.requestedAt) + 180000 - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [job]);
    const apply = async () => {
        if (!data || isRestarting || !data.restartRequired) return;
        const accepted = await restart({
            revision: data.revision,
            scopes: data.pendingScopes ?? ["panel"],
        });
        if (accepted) setSubmittedJob(accepted);
        void refreshSettings();
    };
    return {
        job,
        isRestarting,
        targetUrl,
        jobUrl,
        connectionTimedOut,
        reconnectError,
        restartError,
        apply,
    };
};
