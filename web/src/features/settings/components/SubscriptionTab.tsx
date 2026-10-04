import { Button, Heading, InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { ChevronDownRegular } from "@gamecrafters/base-ui-icons";
import { useId, useRef, useState } from "react";

import { FilledSwitch, FilledTextInput } from "@/components/FilledField";
import type { SubscriptionServiceForm } from "../api/subscription";
import { FOOTER, PLAIN_BUTTON, RESTORE_BUTTON, SAVE_BUTTON } from "./layout";
import { PanelRestartDialog } from "./PanelRestartDialog";
import { SettingsApplicationStatus } from "./SettingsApplicationStatus";
import { startupChanges } from "./startupChanges";
import { useSubscriptionForm } from "./useSubscriptionForm";

const FIELDS = "grid grid-cols-1 gap-2 min-[600px]:grid-cols-2";
type ServiceField = Exclude<keyof SubscriptionServiceForm, "enabled">;
const ADVANCED_FIELDS: { key: ServiceField; label: string; wide?: boolean }[] = [
    { key: "listen", label: "Address" },
    { key: "port", label: "Port" },
    { key: "domain", label: "Domain", wide: true },
    { key: "certFile", label: "SSL certificate path" },
    { key: "keyFile", label: "SSL key path" },
    { key: "trustedProxies", label: "Trusted proxies", wide: true },
];

export const SubscriptionTab = () => {
    const id = useId();
    const form = useSubscriptionForm();
    const { data, values, application, disabled, checkedService, checkedContent } = form;
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [confirmRestart, setConfirmRestart] = useState(false);
    const restartButton = useRef<HTMLButtonElement>(null);
    const advancedInvalid =
        !checkedService.success &&
        checkedService.error.issues.some((issue) =>
            ADVANCED_FIELDS.some((field) => field.key === issue.path[0]),
        );
    const expanded = advancedOpen || advancedInvalid;
    const validation = (key: ServiceField) =>
        checkedService.success
            ? undefined
            : checkedService.error.issues.find((issue) => issue.path[0] === key)?.message;
    const serviceField = (key: ServiceField, label: string, className?: string) => {
        const override = data?.overrides[key];
        return (
            <FilledTextInput
                key={key}
                id={`${id}-${key}`}
                label={label}
                className={className}
                type={key === "port" ? "number" : "text"}
                inputMode={key === "port" ? "numeric" : undefined}
                min={key === "port" ? 1 : undefined}
                max={key === "port" ? 65535 : undefined}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled || Boolean(override)}
                title={override ? `Controlled by ${override}` : undefined}
                value={values[key]}
                validation={validation(key)}
                onChange={(event) => {
                    if (key !== "publicUrl" && key !== "basePath") setAdvancedOpen(true);
                    form.change(key, event.target.value);
                }}
            />
        );
    };

    return (
        <form
            aria-label="Subscription"
            onSubmit={(event) => {
                event.preventDefault();
                void form.save();
            }}
            noValidate
        >
            <div className="p-4">
                <div className="mb-4 flex flex-col gap-2 min-[600px]:flex-row min-[600px]:items-center min-[600px]:justify-between">
                    <Heading as="h3" className="text-[16px]">
                        Subscription
                    </Heading>
                    <FilledSwitch
                        label="Enable subscriptions"
                        disabled={disabled || Boolean(data?.overrides.enabled)}
                        checked={values.enabled}
                        onCheckedChange={(enabled) => form.change("enabled", enabled)}
                    />
                </div>
                {form.readError && !application.isRestarting && (
                    <InlineMessage variant="critical" className="mb-4">
                        {form.readError.message}
                    </InlineMessage>
                )}
                {form.saveError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {form.partialSave &&
                            "Some settings were saved. The remaining changes are still in the form. "}
                        {form.saveError.message}
                    </InlineMessage>
                )}
                {data?.restartRequired && (
                    <InlineMessage variant="warning" className="mb-4">
                        Changes are saved and waiting for a restart.
                    </InlineMessage>
                )}
                {form.message === "saved" && !data?.restartRequired && (
                    <InlineMessage className="mb-4">Settings saved.</InlineMessage>
                )}
                {form.message === "defaults" && (
                    <InlineMessage className="mb-4">
                        {form.isChanged
                            ? "Defaults restored in the form. Save to keep these changes."
                            : "Default values are already saved."}
                    </InlineMessage>
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
                {form.startup && !form.startup.session.secretSet && (
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
                    {serviceField("publicUrl", "Public URL", "min-[600px]:col-span-2")}
                    {serviceField("basePath", "Path")}
                    <FilledTextInput
                        id={`${id}-updates`}
                        label="Refresh interval (hours)"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={168}
                        disabled={disabled}
                        value={values.subUpdates ? String(values.subUpdates) : ""}
                        validation={
                            checkedContent.success
                                ? undefined
                                : checkedContent.error.issues[0]?.message
                        }
                        onChange={(event) =>
                            form.change("subUpdates", Number(event.target.value) || 0)
                        }
                    />
                    <FilledSwitch
                        label="Base64-encode the subscription"
                        disabled={disabled}
                        checked={values.subEncode}
                        onCheckedChange={(subEncode) => form.change("subEncode", subEncode)}
                    />
                    <FilledSwitch
                        label="Show the remaining quota and expiry"
                        disabled={disabled}
                        checked={values.subShowInfo}
                        onCheckedChange={(subShowInfo) => form.change("subShowInfo", subShowInfo)}
                    />
                </div>
                <div className="mt-4 border-t border-[var(--border-color-default)] pt-2">
                    <div className="flex items-center justify-between">
                        <Button
                            id={`${id}-advanced-button`}
                            type="button"
                            className={`${PLAIN_BUTTON} -ms-2`}
                            aria-expanded={expanded}
                            aria-controls={`${id}-advanced`}
                            onClick={() => setAdvancedOpen(!expanded)}
                        >
                            <span className="flex items-center gap-2">
                                <ChevronDownRegular
                                    aria-hidden
                                    size={16}
                                    className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
                                />
                                <span>Advanced</span>
                            </span>
                        </Button>
                        <Button
                            type="button"
                            className={PLAIN_BUTTON}
                            aria-expanded={helpOpen}
                            aria-controls={`${id}-help`}
                            onClick={() => setHelpOpen(!helpOpen)}
                        >
                            Help
                        </Button>
                    </div>
                    <div id={`${id}-help`} hidden={!helpOpen}>
                        <Text
                            as="p"
                            className="my-2 text-[12px] leading-5 text-[var(--foreground-color-muted)]"
                        >
                            Public URL is the external HTTP or HTTPS base address, including any
                            reverse proxy prefix. Path is appended to it. Local HTTPS needs both SSL
                            certificate and key paths. Separate trusted proxy IP addresses or CIDR
                            ranges with commas. Refresh and encoding options take effect when saved;
                            address and SSL changes require Restart &amp; Apply.
                        </Text>
                    </div>
                    <div
                        id={`${id}-advanced`}
                        role="region"
                        aria-labelledby={`${id}-advanced-button`}
                        hidden={!expanded}
                    >
                        <div className={`${FIELDS} mt-2`}>
                            {ADVANCED_FIELDS.map(({ key, label, wide }) =>
                                serviceField(
                                    key,
                                    label,
                                    wide ? "min-[600px]:col-span-2" : undefined,
                                ),
                            )}
                        </div>
                        {data && Object.keys(data.overrides).length > 0 && (
                            <InlineMessage className="mt-4">
                                These fields are controlled by environment variables:{" "}
                                {Object.entries(data.overrides)
                                    .map(([key, env]) => `${key} (${env})`)
                                    .join(", ")}
                                .
                            </InlineMessage>
                        )}
                    </div>
                </div>
            </div>
            <div className={FOOTER}>
                <Button
                    type="button"
                    disabled={disabled}
                    className={RESTORE_BUTTON}
                    onClick={form.restoreDefaults}
                >
                    Restore defaults
                </Button>
                <Button
                    type="button"
                    disabled={disabled || !form.hasDraft}
                    className={PLAIN_BUTTON}
                    onClick={form.discard}
                >
                    Discard changes
                </Button>
                <Button
                    ref={restartButton}
                    type="button"
                    loading={application.isRestarting}
                    className={PLAIN_BUTTON}
                    disabled={
                        disabled ||
                        form.isChanged ||
                        !data?.restartRequired ||
                        !data.restartSupported
                    }
                    onClick={() => setConfirmRestart(true)}
                >
                    Restart &amp; Apply
                </Button>
                <Button
                    type="submit"
                    variant="primary"
                    loading={form.isSaving}
                    className={SAVE_BUTTON}
                    disabled={
                        disabled ||
                        !form.isChanged ||
                        !checkedContent.success ||
                        !checkedService.success
                    }
                >
                    Save
                </Button>
            </div>
            {confirmRestart && (
                <PanelRestartDialog
                    targetUrl={application.targetUrl}
                    addressChanged={application.targetUrl !== window.location.href}
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
                        if (!disabled && !form.isChanged) void application.apply();
                    }}
                />
            )}
        </form>
    );
};
