import {
    Button,
    ConfirmationDialog,
    Dialog,
    InlineMessage,
    Stack,
    Text,
} from "@gamecrafters/base-ui/react";
import { useEffect, useId, useState, type RefObject } from "react";

import { FilledSelect } from "@/components/FilledField";
import { RequestError } from "@/lib/request";

import {
    coreVersionMessage,
    isCoreVersionActive,
    useCheckCoreVersion,
    useCoreVersionJob,
    useCoreVersionTracking,
    useCoreVersions,
    useRefreshCoreVersions,
    useStartCoreVersion,
    type CoreVersionCheck,
} from "../api/core-version";

export const CoreVersionDialog = ({
    onClose,
    returnFocusRef,
}: {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}) => {
    const selectId = useId();
    const { data: status, error: statusError, mutate } = useCoreVersions();
    const trackedId = useCoreVersionTracking((state) => state.id);
    const { data: polled, error: jobError } = useCoreVersionJob(status?.job?.id ?? trackedId);
    const refresh = useRefreshCoreVersions();
    const check = useCheckCoreVersion();
    const start = useStartCoreVersion();
    const [selected, setSelected] = useState("");
    const [checked, setChecked] = useState<CoreVersionCheck>();
    const [confirmation, setConfirmation] = useState<CoreVersionCheck>();
    useEffect(() => {
        if (!checked) return;
        const timer = setTimeout(
            () => setChecked(undefined),
            Math.max(0, Date.parse(checked.checkedAt) + 600000 - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [checked]);
    const job = polled ?? status?.job;
    const busy = isCoreVersionActive(job) || job?.needsRecovery;
    const version =
        selected ||
        (busy ? job?.toVersion : "") ||
        status?.versions.find((release) => release.version !== status.currentVersion)?.version ||
        "";
    const validCheck =
        checked &&
        checked.target.version === version &&
        checked.currentVersion === status?.currentVersion &&
        checked.configRevision === status.configRevision;
    const error = jobError ?? statusError;
    return (
        <>
            <Dialog
                title="sing-box versions"
                width={600}
                onClose={onClose}
                returnFocusRef={returnFocusRef}
            >
                <Stack gap="normal">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-start">
                        <dt>Target</dt>
                        <dd>This server</dd>
                        <dt>Current version</dt>
                        <dd>{status?.currentVersion || job?.fromVersion || "Unavailable"}</dd>
                    </dl>
                    <Text>
                        Choose an official stable version. This panel requires sing-box 1.14 or
                        newer and its native statistics API.
                    </Text>
                    {status?.reason && !busy && (
                        <InlineMessage variant="warning">{status.reason}</InlineMessage>
                    )}
                    <FilledSelect
                        id={selectId}
                        label="Target version"
                        value={version}
                        disabled={
                            !status?.supported ||
                            Boolean(busy) ||
                            check.isMutating ||
                            refresh.isMutating
                        }
                        onChange={(event) => {
                            setSelected(event.target.value);
                            setChecked(undefined);
                            check.reset();
                            start.reset();
                        }}
                    >
                        <option value="">Select a version</option>
                        {busy &&
                            job &&
                            !status?.versions.some(
                                (release) => release.version === job.toVersion,
                            ) && <option value={job.toVersion}>{job.toVersion}</option>}
                        {status?.versions.map((release) => (
                            <option
                                key={release.version}
                                value={release.version}
                                disabled={release.version === status.currentVersion}
                            >
                                {release.version}
                                {release.version === status.currentVersion ? " (current)" : ""}
                            </option>
                        ))}
                    </FilledSelect>
                    {checked?.target.version === version && (
                        <>
                            <Text>
                                {checked.currentVersion} → {checked.target.version}
                            </Text>
                            <Button
                                as="a"
                                href={checked.target.url}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                View release notes
                            </Button>
                            <Text>
                                Official target and recovery packages are pinned. Configuration
                                compatibility will be checked before sing-box stops.
                            </Text>
                        </>
                    )}
                    {status?.blockedReason && !isCoreVersionActive(job) && (
                        <InlineMessage variant="warning">{status.blockedReason}</InlineMessage>
                    )}
                    {(status?.checkError || refresh.error || check.error) && (
                        <InlineMessage variant="critical">
                            {check.error?.message ?? refresh.error?.message ?? status?.checkError}
                        </InlineMessage>
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
                            <div role="status">{coreVersionMessage(job)}</div>
                            <div>
                                {job.fromVersion} → {job.toVersion}
                            </div>
                            {job.error && <div>{job.error}</div>}
                            {job.needsRecovery && (
                                <Text>
                                    Run x-ui-cli core-version-resume on this server. The previous
                                    package and state backup are retained.
                                </Text>
                            )}
                        </InlineMessage>
                    )}
                    {error && (
                        <InlineMessage variant="warning">
                            {error instanceof RequestError && error.status === 401
                                ? "Your session expired. Sign in again to inspect the version change."
                                : "Waiting for the panel to reconnect. The version change result has not yet been confirmed."}
                            <Button type="button" onClick={() => void mutate()}>
                                Retry connection
                            </Button>
                        </InlineMessage>
                    )}
                    <Stack direction="horizontal" gap="normal" wrap="wrap">
                        <Button
                            type="button"
                            loading={refresh.isMutating}
                            disabled={!status?.supported || Boolean(busy) || check.isMutating}
                            onClick={() => {
                                setChecked(undefined);
                                void refresh.trigger();
                            }}
                        >
                            Refresh versions
                        </Button>
                        <Button
                            type="button"
                            loading={check.isMutating}
                            disabled={
                                !version ||
                                !status?.supported ||
                                Boolean(busy) ||
                                Boolean(status.blockedReason) ||
                                refresh.isMutating
                            }
                            onClick={async () => {
                                setChecked(undefined);
                                const result = await check.trigger({ version });
                                if (result) setChecked(result);
                            }}
                        >
                            Check selected version
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            disabled={
                                !validCheck ||
                                Boolean(busy) ||
                                check.isMutating ||
                                Boolean(status?.blockedReason)
                            }
                            onClick={() => {
                                start.reset();
                                setConfirmation(checked);
                            }}
                        >
                            {(checked?.direction ?? (busy ? job?.direction : undefined)) ===
                            "downgrade"
                                ? "Downgrade"
                                : "Upgrade"}
                        </Button>
                    </Stack>
                </Stack>
            </Dialog>
            {confirmation && (
                <ConfirmationDialog
                    title={`${confirmation.direction === "downgrade" ? "Downgrade" : "Upgrade"} sing-box to ${confirmation.target.version}`}
                    confirmButtonContent={
                        confirmation.direction === "downgrade" ? "Downgrade now" : "Upgrade now"
                    }
                    confirmButtonType="danger"
                    confirmButtonLoading={start.isMutating}
                    onClose={async (gesture) => {
                        if (gesture !== "confirm") {
                            setConfirmation(undefined);
                            return;
                        }
                        const accepted = await start.trigger({
                            checkId: confirmation.checkId,
                            expectedCurrentVersion: confirmation.currentVersion,
                            configRevision: confirmation.configRevision,
                        });
                        if (accepted) {
                            setConfirmation(undefined);
                            setChecked(undefined);
                        }
                    }}
                >
                    <Stack gap="normal">
                        <Text>
                            {confirmation.currentVersion} → {confirmation.target.version}
                        </Text>
                        <Text>
                            Existing proxy connections will be closed. The selected version will
                            first validate your current configuration. An unsuccessful installation
                            will attempt to restore the previous package, configuration and state.
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
