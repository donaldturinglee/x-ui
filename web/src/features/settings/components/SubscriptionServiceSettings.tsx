import { Button, Heading, InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { useId, useRef, useState, type FormEvent } from "react";
import { useSWRConfig } from "swr";

import { FilledSwitch, FilledTextInput } from "@/components/FilledField";
import { useStartupSettings } from "../api";
import { PANEL_SETTINGS_KEY } from "../api/panel";
import {
    fromSubscriptionSettings,
    subscriptionSettingsRequest,
    subscriptionPublicBase,
    useSaveSubscriptionSettings,
    useSubscriptionSettings,
    type SubscriptionServiceForm,
} from "../api/subscription";
import { FIELDS, FOOTER, PLAIN_BUTTON, SAVE_BUTTON } from "./layout";
import { PanelRestartDialog } from "./PanelRestartDialog";
import { SettingsApplicationStatus } from "./SettingsApplicationStatus";
import { startupChanges } from "./startupChanges";
import { useSettingsApplication } from "./useSettingsApplication";

const SERVICE_FIELDS: { key: Exclude<keyof SubscriptionServiceForm, "enabled">; label: string }[] =
    [
        { key: "listen", label: "Address" },
        { key: "port", label: "Port" },
        { key: "basePath", label: "Path" },
        { key: "domain", label: "Domain" },
        { key: "keyFile", label: "SSL key path" },
        { key: "certFile", label: "SSL certificate path" },
        { key: "publicUrl", label: "Public URL" },
        { key: "trustedProxies", label: "Trusted proxies" },
    ];
const EMPTY_FORM: SubscriptionServiceForm = {
    enabled: true,
    listen: "",
    port: "8443",
    basePath: "/sub/",
    domain: "",
    keyFile: "",
    certFile: "",
    publicUrl: "",
    trustedProxies: "",
};

export const SubscriptionServiceSettings = () => {
    const id = useId();
    const { mutate } = useSWRConfig();
    const { data, error: readError, isLoading, mutate: refresh } = useSubscriptionSettings();
    const { data: startup } = useStartupSettings();
    const {
        trigger: save,
        isMutating: isSaving,
        error: saveError,
        reset: resetSave,
    } = useSaveSubscriptionSettings();
    const [draft, setDraft] = useState<{
        values: SubscriptionServiceForm;
        revision: string;
    } | null>(null);
    const [savedMessage, setSavedMessage] = useState(false);
    const [confirmRestart, setConfirmRestart] = useState(false);
    const restartButton = useRef<HTMLButtonElement>(null);
    const application = useSettingsApplication(data, "subscription");
    const { isRestarting, targetUrl } = application;
    const saved = data ? fromSubscriptionSettings(data.saved) : EMPTY_FORM;
    const values = draft?.values ?? saved;
    const isChanged = draft !== null && JSON.stringify(values) !== JSON.stringify(saved);
    const checked = subscriptionSettingsRequest.safeParse(values);
    const disabled = isLoading || !data || isSaving || isRestarting;
    const previewUri = checked.success
        ? subscriptionPublicBase(checked.data, window.location.hostname)
        : (data?.savedUri ?? "");
    const change = (key: keyof SubscriptionServiceForm, value: string | boolean) => {
        if (!data) return;
        setDraft({
            values: { ...values, [key]: value },
            revision: draft?.revision ?? data.revision,
        });
        setSavedMessage(false);
        resetSave();
    };
    const onSave = async (event: FormEvent) => {
        event.preventDefault();
        if (disabled || !isChanged || !draft || !checked.success) return;
        if (await save({ revision: draft.revision, values: checked.data })) {
            setDraft(null);
            setSavedMessage(true);
            void mutate(PANEL_SETTINGS_KEY);
        }
    };
    return (
        <form aria-label="Subscription service" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="border-t border-[var(--border-color-default)] p-4">
                <Heading as="h3" className="mb-2 text-[16px]">
                    Subscription service
                </Heading>
                <Text
                    as="p"
                    className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    Save service changes, then choose Restart &amp; Apply. Changing the subscription
                    address may require subscribers to update their URLs.
                </Text>
                {readError && !isRestarting && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}
                {data?.restartRequired && (
                    <InlineMessage variant="warning" className="mb-4">
                        Changes are saved and waiting for a restart. The confirmation will list all
                        pending Panel and Subscription changes.
                    </InlineMessage>
                )}
                {savedMessage && !data?.restartRequired && (
                    <InlineMessage className="mb-4">Settings saved.</InlineMessage>
                )}
                {data?.restartRequired && !data.restartSupported && (
                    <InlineMessage variant="warning" className="mb-4">
                        {data.restartUnavailableReason ??
                            "Automatic restart is unavailable. Use x-ui restart on the server."}
                    </InlineMessage>
                )}
                <SettingsApplicationStatus
                    application={application}
                    restartRequired={data?.restartRequired}
                />
                {startup && !startup.session.secretSet && (
                    <InlineMessage variant="warning" className="mb-4">
                        No session secret is configured. You will need to sign in again after the
                        restart.
                    </InlineMessage>
                )}
                {data && !data.running.enabled && (
                    <InlineMessage variant="warning" className="mb-4">
                        Subscriptions are currently switched off.
                    </InlineMessage>
                )}
                <div className={FIELDS}>
                    <FilledTextInput
                        id={`${id}-running-uri`}
                        label="Current subscription URI"
                        className="min-[840px]:col-span-3"
                        readOnly
                        value={data?.runningUri ?? ""}
                    />
                    <FilledTextInput
                        id={`${id}-preview-uri`}
                        label="Subscription URI after applying"
                        className="min-[840px]:col-span-3"
                        readOnly
                        value={previewUri}
                    />
                    <FilledSwitch
                        label="Enable subscriptions"
                        className="min-[840px]:col-span-3"
                        disabled={disabled || Boolean(data?.overrides.enabled)}
                        checked={values.enabled}
                        onCheckedChange={(enabled) => change("enabled", enabled)}
                    />
                    {SERVICE_FIELDS.map((field) => {
                        const override = data?.overrides[field.key];
                        const validation = checked.success
                            ? undefined
                            : checked.error.issues.find((issue) => issue.path[0] === field.key)
                                  ?.message;
                        return (
                            <FilledTextInput
                                key={field.key}
                                id={`${id}-${field.key}`}
                                label={field.label}
                                details
                                type={field.key === "port" ? "number" : "text"}
                                min={field.key === "port" ? 1 : undefined}
                                max={field.key === "port" ? 65535 : undefined}
                                disabled={disabled || Boolean(override)}
                                title={override ? `Controlled by ${override}` : undefined}
                                value={values[field.key]}
                                validation={validation}
                                onChange={(event) => change(field.key, event.target.value)}
                            />
                        );
                    })}
                </div>
                <Text
                    as="p"
                    className="mt-4 text-[12px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    Public URL is the external HTTP or HTTPS base address, including any reverse
                    proxy prefix. The Path is appended to it. Local HTTPS uses the SSL certificate
                    and key paths. Separate trusted proxy IP addresses or CIDR ranges with commas.
                </Text>
                {data && Object.keys(data.overrides).length > 0 && (
                    <InlineMessage className="mt-4">
                        These fields are controlled by environment variables:{" "}
                        {Object.entries(data.overrides)
                            .map(([key, env]) => `${key} (${env})`)
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
                    className={PLAIN_BUTTON}
                    disabled={
                        disabled || isChanged || !data?.restartRequired || !data.restartSupported
                    }
                    onClick={() => setConfirmRestart(true)}
                >
                    Restart &amp; Apply
                </Button>
                <Button
                    type="submit"
                    variant="primary"
                    loading={isSaving}
                    className={SAVE_BUTTON}
                    disabled={disabled || !isChanged || !checked.success}
                >
                    Save
                </Button>
            </div>
            {confirmRestart && (
                <PanelRestartDialog
                    targetUrl={targetUrl}
                    addressChanged={targetUrl !== window.location.href}
                    scopes={data?.pendingScopes}
                    changes={
                        data
                            ? startupChanges(
                                  data.pendingScopes,
                                  data.savedPanel,
                                  data.runningPanel,
                                  data.saved,
                                  data.running,
                              )
                            : []
                    }
                    subscriptionUri={data?.savedUri}
                    returnFocusRef={restartButton}
                    onClose={() => setConfirmRestart(false)}
                    onConfirm={() => {
                        setConfirmRestart(false);
                        if (!disabled && !isChanged) void application.apply();
                    }}
                />
            )}
        </form>
    );
};
