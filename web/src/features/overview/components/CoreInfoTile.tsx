import { Badge, Button } from "@gamecrafters/base-ui/react";
import { useEffect, useRef, useState } from "react";

import { formatUptime } from "../api";
import {
    coreRestartMessage,
    isCoreRestartActive,
    useCoreRestartJob,
    useCoreStatus,
    useRestartCore,
    type CoreRestartJob,
} from "../api/core";
import {
    coreVersionMessage,
    isCoreVersionActive,
    useCoreVersionJob,
    useCoreVersions,
} from "../api/core-version";

import { CoreLogsDialog } from "./CoreLogsDialog";
import { CoreRestartDialog } from "./CoreRestartDialog";
import { CoreVersionDialog } from "./CoreVersionDialog";
import { Tile } from "./Tile";

const stateLabel = (state?: string) => {
    switch (state) {
        case "active":
            return "Running";
        case "inactive":
            return "Stopped";
        case "failed":
            return "Failed";
        case "activating":
            return "Starting";
        case "deactivating":
            return "Stopping";
        case "unavailable":
            return "Unavailable";
        default:
            return "Unknown";
    }
};

export const CoreInfoTile = () => {
    const { data, error: statusError, mutate: refresh } = useCoreStatus();
    const { data: versions } = useCoreVersions();
    const { data: versionTask } = useCoreVersionJob(versions?.job?.id);
    const versionJob = versionTask ?? versions?.job;
    const isChangingVersion = isCoreVersionActive(versionJob) || Boolean(versionJob?.needsRecovery);
    const versionButton = useRef<HTMLButtonElement>(null);
    const [showVersions, setShowVersions] = useState(false);
    const {
        trigger: restart,
        isMutating: isScheduling,
        error: restartError,
        reset,
    } = useRestartCore();
    const [isConfirming, setIsConfirming] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [submitted, setSubmitted] = useState<CoreRestartJob | null>(null);
    const [timedOut, setTimedOut] = useState<string | null>(null);
    const followed =
        submitted &&
        (!data?.restartJob ||
            Date.parse(submitted.requestedAt) > Date.parse(data.restartJob.requestedAt))
            ? submitted
            : data?.restartJob;
    const { data: polled, error: progressError } = useCoreRestartJob(
        followed?.id,
        () => void refresh(),
    );
    const job = polled ?? followed;
    const isRestarting = isScheduling || isCoreRestartActive(job);
    useEffect(() => {
        if (!job || !isCoreRestartActive(job)) return;
        const timer = window.setTimeout(
            () => setTimedOut(job.id),
            Math.max(0, Date.parse(job.requestedAt) + 120000 - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [job]);

    const onConfirm = async () => {
        const accepted = await restart();
        if (accepted) {
            setSubmitted(accepted);
            setIsConfirming(false);
            void refresh();
        }
    };
    const reason = statusError?.message ?? data?.reason ?? versions?.reason;
    const progress = isChangingVersion
        ? coreVersionMessage(versionJob)
        : job && progressError && timedOut === job.id
          ? "Restart result is unconfirmed. Refresh or view logs."
          : coreRestartMessage(job) || coreVersionMessage(versionJob);

    return (
        <>
            <Tile
                title="sing-box"
                action={
                    <Button
                        ref={versionButton}
                        type="button"
                        size="small"
                        className="ms-2"
                        aria-label="Version management"
                        disabled={(!versions?.supported && !versionJob) || isRestarting}
                        title={versions?.reason ?? "Version management"}
                        onClick={() => setShowVersions(true)}
                    >
                        Versions
                    </Button>
                }
            >
                <div className="grid grid-cols-12 items-center gap-x-2">
                    <div className="col-span-4">Target</div>
                    <div className="col-span-8">This server</div>
                    <div className="col-span-4">Version</div>
                    <div className="col-span-8">
                        {data?.currentVersion || versions?.currentVersion || "—"}
                    </div>
                    <div className="col-span-4">Status</div>
                    <div className="col-span-8">
                        <Badge variant={data?.state === "active" ? "success" : "attention"}>
                            {stateLabel(data?.state)}
                        </Badge>
                    </div>
                    <div className="col-span-4">PID</div>
                    <div className="col-span-8">{data?.pid ? data.pid : "—"}</div>
                    <div className="col-span-4">Uptime</div>
                    <div className="col-span-8">
                        {data?.pid ? formatUptime(data.uptimeSeconds) : "—"}
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                    <Button
                        type="button"
                        size="small"
                        loading={isRestarting}
                        disabled={
                            !data?.supported ||
                            isRestarting ||
                            isChangingVersion ||
                            Boolean(statusError)
                        }
                        onClick={() => {
                            reset();
                            setIsConfirming(true);
                        }}
                    >
                        Restart sing-box
                    </Button>
                    <Button
                        type="button"
                        size="small"
                        aria-label="sing-box logs"
                        disabled={!data || data.state === "unavailable"}
                        onClick={() => setShowLogs(true)}
                    >
                        Logs
                    </Button>
                </div>
                <p
                    aria-live="polite"
                    title={reason ?? (job?.state === "failed" ? (job.error ?? progress) : progress)}
                    className="mt-1 truncate text-[12px] leading-4 text-[var(--foreground-color-muted)]"
                >
                    {isChangingVersion ? progress : (reason ?? progress)}
                </p>
            </Tile>
            {isConfirming && (
                <CoreRestartDialog
                    onClose={() => setIsConfirming(false)}
                    onConfirm={onConfirm}
                    isScheduling={isScheduling}
                    error={restartError}
                />
            )}
            {showLogs && (
                <CoreLogsDialog onClose={() => setShowLogs(false)} restartError={job?.error} />
            )}
            {showVersions && (
                <CoreVersionDialog
                    onClose={() => setShowVersions(false)}
                    returnFocusRef={versionButton}
                />
            )}
        </>
    );
};
