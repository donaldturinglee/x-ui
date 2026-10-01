import { Button, InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { useId, useState } from "react";

import { DocLink } from "@/components/DocLink";
import { FilledSwitch, FilledTextInput } from "@/components/FilledField";
import {
    DOC_LINKS,
    intervalMinutes,
    isNtpChanged,
    NTP_DEFAULTS,
    ntpOf,
    withNtp,
    type Ntp,
} from "@/features/basics/api";
import { toDocument, useBaseConfig, useSaveBaseConfig } from "@/features/config/api";

import { FIELDS, FOOTER, SAVE_BUTTON } from "./layout";

// The node's clock is one key of the base document. Keep its draft separate
// from the HTTP clients tab, and replace only `ntp` when it is saved.
export const NtpTab = () => {
    const serverId = useId();
    const portId = useId();
    const intervalId = useId();

    const { data: config, error: readError } = useBaseConfig();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveBaseConfig();

    // The wrapper distinguishes no edit from an edit that switched NTP off.
    const [draft, setDraft] = useState<{ ntp: Ntp | undefined } | null>(null);
    const ntp = draft === null ? ntpOf(config) : draft.ntp;
    const isReady = config !== undefined;
    const isChanged = draft !== null && isNtpChanged(config, draft.ntp);

    const changeNtp = (changes: Ntp) => setDraft({ ntp: { ...(ntp ?? {}), ...changes } });

    const onSave = async () => {
        if (!config) {
            return;
        }

        if (await save({ document: toDocument(withNtp(config, ntp)) })) {
            setDraft(null);
        }
    };

    return (
        <div>
            <div className="p-4">
                <Text
                    as="p"
                    className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    The clock every node's core keeps. <DocLink href={DOC_LINKS.ntp} label="NTP" />
                </Text>

                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}

                <div className={FIELDS}>
                    <FilledSwitch
                        label="Enabled"
                        disabled={!isReady}
                        checked={ntp?.enabled === true}
                        onCheckedChange={(enabled) =>
                            setDraft({
                                ntp: enabled
                                    ? { ...NTP_DEFAULTS, ...(ntp ?? {}), enabled: true }
                                    : undefined,
                            })
                        }
                    />
                    {ntp?.enabled === true && (
                        <>
                            <FilledTextInput
                                id={serverId}
                                label="Server"
                                autoComplete="off"
                                spellCheck={false}
                                value={typeof ntp.server === "string" ? ntp.server : ""}
                                onChange={(event) =>
                                    changeNtp({ server: event.target.value || undefined })
                                }
                            />
                            <FilledTextInput
                                id={portId}
                                label="Port"
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={
                                    typeof ntp.server_port === "number"
                                        ? String(ntp.server_port)
                                        : ""
                                }
                                onChange={(event) =>
                                    changeNtp({
                                        server_port: Number(event.target.value) || undefined,
                                    })
                                }
                            />
                            <FilledTextInput
                                id={intervalId}
                                label="Interval (minutes)"
                                type="number"
                                inputMode="numeric"
                                min={0}
                                value={String(intervalMinutes(ntp.interval) ?? "")}
                                onChange={(event) => {
                                    const minutes = Number(event.target.value);
                                    changeNtp({
                                        interval: minutes > 0 ? `${minutes}m` : undefined,
                                    });
                                }}
                            />
                        </>
                    )}
                </div>

                {saveError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {saveError.message}
                    </InlineMessage>
                )}
            </div>

            <div className={FOOTER}>
                <Button
                    variant="primary"
                    loading={isSaving}
                    disabled={!isReady || !isChanged}
                    className={SAVE_BUTTON}
                    onClick={() => void onSave()}
                >
                    Save
                </Button>
            </div>
        </div>
    );
};
