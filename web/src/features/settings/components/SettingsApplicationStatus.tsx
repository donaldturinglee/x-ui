import { InlineMessage } from "@gamecrafters/base-ui/react";

import { RequestError } from "@/lib/request";
import { isPanelRestartActive } from "../api/panel";
import type { useSettingsApplication } from "./useSettingsApplication";

export const SettingsApplicationStatus = ({
    application,
    restartRequired,
}: {
    application: ReturnType<typeof useSettingsApplication>;
    restartRequired?: boolean;
}) => {
    const { job, jobUrl, connectionTimedOut, reconnectError, restartError } = application;
    return (
        <>
            {job && (job.state !== "succeeded" || !restartRequired) && (
                <InlineMessage
                    variant={
                        job.state === "failed" || job.state === "rolled_back" || connectionTimedOut
                            ? "warning"
                            : undefined
                    }
                    className="mb-4"
                >
                    {job.state === "queued" &&
                        "Restart scheduled. Waiting for the panel to restart."}
                    {job.state === "running" && "Restarting services and reconnecting…"}
                    {job.state === "rolling_back" &&
                        "Restoring the previous configuration and reconnecting…"}
                    {job.state === "succeeded" &&
                        !restartRequired &&
                        "Panel restarted. Saved settings are now applied."}
                    {(job.state === "failed" || job.state === "rolled_back") && job.error}
                    {connectionTimedOut &&
                        " Unable to reconnect. The server's restart result has not been confirmed."}
                    {reconnectError instanceof RequestError &&
                        reconnectError.status === 401 &&
                        " Sign in again to check the restart result."}
                    {isPanelRestartActive(job) && jobUrl !== window.location.href && (
                        <p className="mt-2">
                            <a href={jobUrl} className="break-all underline">
                                Open updated panel: {jobUrl}
                            </a>
                        </p>
                    )}
                </InlineMessage>
            )}
            {restartError && (
                <InlineMessage variant="critical" className="mb-4">
                    {restartError.message}
                </InlineMessage>
            )}
        </>
    );
};
