import { InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { useId } from "react";

import { FilledTextInput } from "@/components/FilledField";

import { inUnits, useStartupSettings } from "../api";

import { FIELDS } from "./layout";

// A schedule left empty or written as "off" is a job the worker does not run,
// which is said rather than left as a blank for an operator to guess at.
const scheduleOf = (spec: string) => (spec === "" || spec === "off" ? "Off" : spec);

// The panel's own listener, its sessions and the worker's schedules, as the
// process read them from configs/config.yaml and the X_UI_* environment
// when it started: the reference's interface tab, in its order and three to a
// row.
//
// They are shown rather than changed. Everything the process needs in order to
// start comes from that file, which an operator may have no way to edit from
// here, and a panel that rewrote its own port could leave itself unreachable --
// the file is the one place that can always be put right. So there is nothing
// to save, and the reference's restart is not offered: the process is
// restarted by whatever runs it.
export const PanelTab = () => {
    const listenId = useId();
    const portId = useId();
    const pathId = useId();
    const domainId = useId();
    const keyId = useId();
    const certificateId = useId();
    const proxiesId = useId();
    const sessionId = useId();
    const retentionId = useId();
    const bucketId = useId();
    const zoneId = useId();
    const resetId = useId();
    const depleteId = useId();
    const cleanupId = useId();
    const logId = useId();

    const { data: startup, error } = useStartupSettings();
    const panel = startup?.panel;
    const session = startup?.session;
    const worker = startup?.worker;

    return (
        <div className="p-4">
            <Text
                as="p"
                className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
            >
                Read from configs/config.yaml and the X_UI_* environment when the panel started. To
                change one, change it there and restart the panel and the worker.
            </Text>

            {error && (
                <InlineMessage variant="critical" className="mb-4">
                    {error.message}
                </InlineMessage>
            )}

            {/* A secret made at start is one no other start knows, so every
                operator is signed out whenever the panel restarts. */}
            {session && !session.secretSet && (
                <InlineMessage variant="warning" className="mb-4">
                    No session secret is configured, so one is made at every start and every session
                    ends when the panel restarts.
                </InlineMessage>
            )}

            <div className={FIELDS}>
                <FilledTextInput
                    id={listenId}
                    label="Address"
                    readOnly
                    value={panel?.listen ?? ""}
                />
                <FilledTextInput
                    id={portId}
                    label="Port"
                    readOnly
                    value={panel ? String(panel.port) : ""}
                />
                <FilledTextInput
                    id={pathId}
                    label="Web path"
                    readOnly
                    value={panel?.basePath ?? ""}
                />
                <FilledTextInput
                    id={domainId}
                    label="Domain"
                    readOnly
                    value={panel?.domain ?? ""}
                />
                <FilledTextInput
                    id={keyId}
                    label="SSL key path"
                    readOnly
                    value={panel?.keyFile ?? ""}
                />
                <FilledTextInput
                    id={certificateId}
                    label="SSL certificate path"
                    readOnly
                    value={panel?.certFile ?? ""}
                />
                <FilledTextInput
                    id={sessionId}
                    label="Session length (minutes)"
                    readOnly
                    value={session ? inUnits(session.maxAgeSeconds, 60) : ""}
                />
                <FilledTextInput
                    id={retentionId}
                    label="Traffic kept for (days)"
                    readOnly
                    value={worker ? inUnits(worker.statsRetentionSeconds, 86_400) : ""}
                />
                <FilledTextInput
                    id={bucketId}
                    label="Traffic bucket (seconds)"
                    readOnly
                    value={worker ? String(worker.statsBucketSeconds) : ""}
                />
                <FilledTextInput
                    id={zoneId}
                    label="Time zone"
                    readOnly
                    value={worker?.timeLocation ?? ""}
                />
                <FilledTextInput
                    id={resetId}
                    label="Global traffic reset"
                    readOnly
                    value={worker ? scheduleOf(worker.resetSpec) : ""}
                />
                <FilledTextInput
                    id={depleteId}
                    label="Quota enforcement"
                    readOnly
                    value={worker ? scheduleOf(worker.depleteSpec) : ""}
                />
                <FilledTextInput
                    id={cleanupId}
                    label="Retention cleanup"
                    readOnly
                    value={worker ? scheduleOf(worker.cleanupSpec) : ""}
                />
                <FilledTextInput
                    id={proxiesId}
                    label="Trusted proxies"
                    readOnly
                    value={panel ? panel.trustedProxies.join(", ") || "None" : ""}
                />
                <FilledTextInput
                    id={logId}
                    label="Log level"
                    readOnly
                    value={startup?.logLevel ?? ""}
                />
            </div>
        </div>
    );
};
