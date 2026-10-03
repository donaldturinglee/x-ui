import { Button, InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { useId, useRef, useState, type FormEvent } from "react";
import { useSWRConfig } from "swr";

import { FilledSelect, FilledTextInput } from "@/components/FilledField";

import { useStartupSettings } from "../api";
import {
    fromPanelSettings,
    PANEL_LOG_LEVELS,
    panelSettingsRequest,
    usePanelSettings,
    useSavePanelSettings,
    type PanelForm,
} from "../api/panel";

import { FIELDS, FOOTER, PLAIN_BUTTON, SAVE_BUTTON } from "./layout";
import { PanelRestartDialog } from "./PanelRestartDialog";
import { useSettingsApplication } from "./useSettingsApplication";
import { SettingsApplicationStatus } from "./SettingsApplicationStatus";
import { startupChanges } from "./startupChanges";
import { SUBSCRIPTION_SETTINGS_KEY, subscriptionPublicBase } from "../api/subscription";

const PANEL_FIELDS: { key: keyof PanelForm; label: string; numeric?: boolean; min?: number }[] = [
    { key: "listen", label: "Address" },
    { key: "port", label: "Port", numeric: true, min: 1 },
    { key: "basePath", label: "Web path" },
    { key: "domain", label: "Domain" },
    { key: "keyFile", label: "SSL key path" },
    { key: "certFile", label: "SSL certificate path" },
    { key: "maxAgeSeconds", label: "Session length (minutes)", numeric: true, min: 0 },
    { key: "statsRetentionSeconds", label: "Traffic kept for (days)", numeric: true, min: 0 },
    { key: "statsBucketSeconds", label: "Traffic bucket (seconds)", numeric: true, min: 1 },
    { key: "timeLocation", label: "Time zone" },
    { key: "resetSpec", label: "Global traffic reset" },
    { key: "depleteSpec", label: "Quota enforcement" },
    { key: "cleanupSpec", label: "Retention cleanup" },
    { key: "trustedProxies", label: "Trusted proxies" },
    { key: "logLevel", label: "Log level" },
];

const EMPTY_FORM: PanelForm = {
    listen: "",
    port: "",
    basePath: "/",
    domain: "",
    keyFile: "",
    certFile: "",
    trustedProxies: "",
    maxAgeSeconds: "0",
    statsRetentionSeconds: "30",
    statsBucketSeconds: "60",
    timeLocation: "UTC",
    resetSpec: "",
    depleteSpec: "@every 1m",
    cleanupSpec: "@daily",
    logLevel: "info",
};

export const PanelTab = () => {
    const id = useId();
    const { mutate } = useSWRConfig();
    const { data, error: readError, isLoading, mutate: refresh } = usePanelSettings();
    const { data: startup } = useStartupSettings();
    const {
        trigger: save,
        isMutating: isSaving,
        error: saveError,
        reset: resetSave,
    } = useSavePanelSettings();
    // Capture the revision at the first edit. Refreshes cannot silently rebase
    // the draft over another operator's save.
    const [draft, setDraft] = useState<{ values: PanelForm; revision: string } | null>(null);
    const [savedMessage, setSavedMessage] = useState(false);
    const [confirmRestart, setConfirmRestart] = useState(false);
    const restartButton = useRef<HTMLButtonElement>(null);
    const application = useSettingsApplication(
        data && { ...data, savedPanel: data.saved, runningPanel: data.running },
        "panel",
    );
    const { isRestarting, targetUrl } = application;
    const addressChanged = targetUrl !== window.location.href;

    const saved = data ? fromPanelSettings(data.saved) : EMPTY_FORM;
    const values = draft?.values ?? saved;
    const isChanged = draft !== null && JSON.stringify(values) !== JSON.stringify(saved);
    const checked = panelSettingsRequest.safeParse(values);
    const disabled = isLoading || !data || isSaving || isRestarting;

    const change = (key: keyof PanelForm, value: string) => {
        if (data) {
            setDraft({
                values: { ...values, [key]: value },
                revision: draft?.revision ?? data.revision,
            });
            setSavedMessage(false);
            resetSave();
        }
    };

    const onSave = async (event: FormEvent) => {
        event.preventDefault();
        if (disabled || !isChanged) return;
        if (
            draft &&
            checked.success &&
            (await save({ revision: draft.revision, values: checked.data }))
        ) {
            setDraft(null);
            setSavedMessage(true);
            void mutate(SUBSCRIPTION_SETTINGS_KEY);
        }
    };

    const onRestart = async () => {
        setConfirmRestart(false);
        if (!data || disabled || isChanged || !data.restartRequired) return;
        await application.apply();
    };

    return (
        <form aria-label="Panel" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="p-4">
                <Text
                    as="p"
                    className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    Save changes, then choose Restart &amp; Apply to apply them. Changing the
                    address, port, Web path, domain or SSL settings may change where you sign in.
                </Text>
                {readError && !isRestarting && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}
                {data?.restartRequired && (
                    <InlineMessage variant="warning" className="mb-4">
                        Changes are saved and waiting for a restart. Choose Restart &amp; Apply when
                        you are ready to apply them.
                    </InlineMessage>
                )}
                {savedMessage && !data?.restartRequired && (
                    <InlineMessage className="mb-4">Settings saved.</InlineMessage>
                )}
                {data?.restartRequired && !data.restartSupported && (
                    <InlineMessage variant="warning" className="mb-4">
                        {data.restartUnavailableReason ??
                            "Automatic restart is unavailable in this environment. Use x-ui restart on the server."}
                    </InlineMessage>
                )}
                <SettingsApplicationStatus
                    application={application}
                    restartRequired={data?.restartRequired}
                />
                {startup && !startup.session.secretSet && (
                    <InlineMessage variant="warning" className="mb-4">
                        No session secret is configured, so one is made at every start and every
                        session ends when the panel restarts.
                    </InlineMessage>
                )}
                <div className={FIELDS}>
                    {PANEL_FIELDS.map((field) => {
                        const override = data?.overrides[field.key];
                        const fieldError = checked.success
                            ? undefined
                            : checked.error.issues.find((issue) => issue.path[0] === field.key)
                                  ?.message;
                        return field.key === "logLevel" ? (
                            <FilledSelect
                                key={field.key}
                                id={`${id}-${field.key}`}
                                label={field.label}
                                disabled={disabled || Boolean(override)}
                                title={override ? `Controlled by ${override}` : undefined}
                                value={values[field.key]}
                                onChange={(event) => change(field.key, event.target.value)}
                            >
                                {PANEL_LOG_LEVELS.map((level) => (
                                    <option key={level} value={level}>
                                        {level}
                                    </option>
                                ))}
                            </FilledSelect>
                        ) : (
                            <FilledTextInput
                                key={field.key}
                                id={`${id}-${field.key}`}
                                label={field.label}
                                type={field.numeric ? "number" : "text"}
                                inputMode={field.numeric ? "decimal" : undefined}
                                min={field.min}
                                step={field.numeric ? "any" : undefined}
                                disabled={disabled || Boolean(override)}
                                title={override ? `Controlled by ${override}` : undefined}
                                value={values[field.key]}
                                validation={draft ? fieldError : undefined}
                                onChange={(event) => change(field.key, event.target.value)}
                            />
                        );
                    })}
                </div>
                <Text
                    as="p"
                    className="mt-4 text-[12px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    Leave a schedule empty or enter Off to disable it. Separate trusted proxy IP
                    addresses or CIDR ranges with commas. A session length of 0 lasts until the
                    browser closes; traffic retention of 0 keeps no history.
                </Text>
                {data && Object.keys(data.overrides).length > 0 && (
                    <InlineMessage className="mt-4">
                        These fields are controlled by environment variables:{" "}
                        {PANEL_FIELDS.filter(({ key }) => data.overrides[key])
                            .map(({ key, label }) => `${label} (${data.overrides[key]})`)
                            .join(", ")}
                        .
                    </InlineMessage>
                )}
                {saveError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {saveError.message}
                    </InlineMessage>
                )}
            </div>
            <div className={FOOTER}>
                <Button
                    type="button"
                    disabled={!draft || isSaving || isRestarting}
                    className={PLAIN_BUTTON}
                    onClick={() => {
                        setDraft(null);
                        setSavedMessage(false);
                        resetSave();
                        void refresh();
                    }}
                >
                    Discard changes
                </Button>
                <Button
                    ref={restartButton}
                    type="button"
                    loading={isRestarting}
                    disabled={
                        disabled || isChanged || !data?.restartRequired || !data.restartSupported
                    }
                    className={PLAIN_BUTTON}
                    onClick={() => setConfirmRestart(true)}
                >
                    Restart &amp; Apply
                </Button>
                <Button
                    type="submit"
                    variant="primary"
                    loading={isSaving}
                    disabled={disabled || !isChanged || !checked.success}
                    className={SAVE_BUTTON}
                >
                    Save
                </Button>
            </div>
            {confirmRestart && (
                <PanelRestartDialog
                    targetUrl={targetUrl}
                    addressChanged={addressChanged}
                    onClose={() => setConfirmRestart(false)}
                    onConfirm={() => {
                        void onRestart();
                    }}
                    returnFocusRef={restartButton}
                    scopes={data?.pendingScopes}
                    changes={
                        data
                            ? startupChanges(
                                  data.pendingScopes ?? ["panel"],
                                  data.saved,
                                  data.running,
                                  data.savedSubscription,
                                  data.runningSubscription,
                              )
                            : []
                    }
                    subscriptionUri={
                        data?.savedSubscription
                            ? subscriptionPublicBase(
                                  data.savedSubscription,
                                  window.location.hostname,
                              )
                            : undefined
                    }
                />
            )}
        </form>
    );
};
