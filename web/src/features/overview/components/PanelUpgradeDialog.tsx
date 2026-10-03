import {
    Button,
    ConfirmationDialog,
    Dialog,
    InlineMessage,
    Stack,
    Text,
} from "@gamecrafters/base-ui/react";
import { useState, type RefObject } from "react";

import { RequestError } from "@/lib/request";

import {
    isUpgradeActive,
    upgradeMessage,
    useCheckUpgrade,
    useStartUpgrade,
    useUpgradeJob,
    useUpgradeStatus,
    useUpgradeTracking,
    type UpgradeRequest,
    type UpgradeStatus,
} from "../api/upgrade";

export const PanelUpgradeDialog = ({
    onClose,
    returnFocusRef,
}: {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}) => {
    const { data: status, error: statusError, mutate } = useUpgradeStatus();
    const trackedId = useUpgradeTracking((state) => state.id);
    const { data: polledJob, error: jobError } = useUpgradeJob(status?.job?.id ?? trackedId);
    const check = useCheckUpgrade();
    const start = useStartUpgrade();
    const [confirmation, setConfirmation] = useState<{
        request: UpgradeRequest;
        status: UpgradeStatus;
    }>();
    const job = polledJob ?? status?.job;
    const busy = isUpgradeActive(job) || job?.needsRecovery;
    const connectionError = jobError ?? statusError;
    const confirm = () => {
        if (!status?.canUpgrade || !status.checkId) return;
        setConfirmation({
            status,
            request: {
                checkId: status.checkId,
                expectedCurrentVersion: status.currentVersion,
                configRevision: status.configRevision,
            },
        });
        start.reset();
    };

    return (
        <>
            <Dialog title="Upgrade" onClose={onClose} returnFocusRef={returnFocusRef} width={600}>
                <Stack gap="normal">
                    {status && (
                        <>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-start">
                                <dt>Current version</dt>
                                <dd>{status.currentVersion}</dd>
                                <dt>Latest release</dt>
                                <dd>{status.latest?.version ?? "Not checked"}</dd>
                                {status.latest && (
                                    <>
                                        <dt>Published</dt>
                                        <dd>
                                            {new Date(status.latest.publishedAt).toLocaleString()}
                                        </dd>
                                    </>
                                )}
                            </dl>
                            {status.latest && (
                                <Button
                                    as="a"
                                    href={status.latest.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    View release notes
                                </Button>
                            )}
                            {status.components.length > 0 && (
                                <Text>Updates: {status.components.join(", ")}.</Text>
                            )}
                            <Text>
                                The panel will be briefly unavailable. Your configuration, accounts
                                and keys are preserved. The sing-box process and remote nodes keep
                                their current versions.
                            </Text>
                            {status.blockedReason && !busy && (
                                <InlineMessage variant="warning">
                                    {status.blockedReason}
                                </InlineMessage>
                            )}
                            {status.checkError && (
                                <InlineMessage variant="critical">
                                    {status.checkError}
                                </InlineMessage>
                            )}
                            {status.checkedAt && (
                                <Text>
                                    Last checked: {new Date(status.checkedAt).toLocaleString()}
                                </Text>
                            )}
                        </>
                    )}
                    {job && (
                        <InlineMessage
                            variant={
                                job.state === "succeeded"
                                    ? "success"
                                    : job.state === "failed"
                                      ? "critical"
                                      : "warning"
                            }
                        >
                            <div role="status">{upgradeMessage(job)}</div>
                            <div>
                                {job.fromVersion} → {job.toVersion}
                            </div>
                            {job.error && <div>{job.error}</div>}
                            {job.needsRecovery && (
                                <div>
                                    Use x-ui-cli upgrade-resume on the server to retry recovery. The
                                    installation backup is retained.
                                </div>
                            )}
                        </InlineMessage>
                    )}
                    {(jobError || statusError) && (
                        <InlineMessage variant="warning">
                            {connectionError instanceof RequestError &&
                            connectionError.status === 401
                                ? "Your session expired. Sign in again to inspect the upgrade result."
                                : busy || trackedId
                                  ? "Waiting for the panel to reconnect. The upgrade result has not yet been confirmed."
                                  : (statusError ?? jobError)?.message}
                            <Button type="button" onClick={() => void mutate()}>
                                Retry connection
                            </Button>
                        </InlineMessage>
                    )}
                    {check.error && (
                        <InlineMessage variant="critical">{check.error.message}</InlineMessage>
                    )}
                    <Stack direction="horizontal" gap="normal" wrap="wrap">
                        <Button
                            type="button"
                            loading={check.isMutating}
                            disabled={Boolean(busy) || !status?.platform}
                            onClick={() => void check.trigger()}
                        >
                            Check for updates
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            disabled={!status?.canUpgrade || Boolean(busy) || check.isMutating}
                            onClick={confirm}
                        >
                            Upgrade
                        </Button>
                    </Stack>
                </Stack>
            </Dialog>
            {confirmation && (
                <ConfirmationDialog
                    title={`Upgrade to ${confirmation.status.latest?.version}`}
                    confirmButtonContent="Upgrade now"
                    confirmButtonType="danger"
                    confirmButtonLoading={start.isMutating}
                    onClose={async (gesture) => {
                        if (gesture !== "confirm") {
                            setConfirmation(undefined);
                            return;
                        }
                        const job = await start.trigger(confirmation.request);
                        if (job) setConfirmation(undefined);
                    }}
                >
                    <Stack gap="normal">
                        <Text>
                            {confirmation.status.currentVersion} →{" "}
                            {confirmation.status.latest?.version}
                        </Text>
                        <Text>Updates: {confirmation.status.components.join(", ")}.</Text>
                        <Text>
                            The installation and complete database will be backed up before
                            migration. Services will restart, and an unsuccessful upgrade will
                            attempt to restore the previous version and database.
                        </Text>
                        {start.error && (
                            <InlineMessage variant="critical">{start.error.message}</InlineMessage>
                        )}
                    </Stack>
                </ConfirmationDialog>
            )}
        </>
    );
};
