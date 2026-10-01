import { Button, Heading, InlineMessage } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent } from "react";

import { FilledSwitch, FilledTextInput } from "@/components/FilledField";
import { useSubscriptionBase } from "@/features/clients/api";

import {
    fromSettings,
    settingsRequest,
    SUBSCRIPTION_KEYS,
    toSettingsPayload,
    useResetSettings,
    useSaveSettings,
    useSettings,
    useStartupSettings,
    type SettingsRequest,
} from "../api";

import { FIELDS, FOOTER, GROUP_HEADING, RESTORE_BUTTON, SAVE_BUTTON } from "./layout";

// What the fields show before the settings have been read: the API's own
// defaults, so nothing reads as blank for the moment the read takes.
const DEFAULTS: SettingsRequest = { subUpdates: 12, subEncode: true, subShowInfo: false };

// How subscribers are served their subscription: where it is fetched from and
// how often an application fetches it again along the top, how it is written
// for them under that, and under a line of its own the listener that serves it,
// as the process read it from configs/. The buttons that save the options and
// put them back to the panel's defaults are along the foot.
//
// The reference sets the listener's address, port, path and certificate on this
// tab. Here they are shown rather than changed: everything the process needs in
// order to start comes from configs/config.yaml, a file an operator may have no
// way to edit from here, and a panel that moved its own subscriptions could
// leave every subscriber without them. The JSON and Clash subscription
// extensions the reference has tabs for are not something this panel renders.
export const SubscriptionTab = () => {
    const updatesId = useId();
    const uriId = useId();
    const listenId = useId();
    const portId = useId();
    const pathId = useId();
    const domainId = useId();
    const certificateId = useId();
    const keyId = useId();

    const { data: settings, error: readError, isLoading } = useSettings();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveSettings();
    const {
        trigger: restore,
        isMutating: isResetting,
        error: resetError,
    } = useResetSettings(SUBSCRIPTION_KEYS);
    const { data: base } = useSubscriptionBase();
    const { data: startup } = useStartupSettings();

    // What was typed, kept apart from what was read until it is saved, so a read
    // that answers later is shown rather than overwritten.
    const [draft, setDraft] = useState<SettingsRequest | null>(null);

    const saved = settings ? fromSettings(settings) : undefined;
    const values = draft ?? saved ?? DEFAULTS;
    const isChanged =
        draft !== null && saved !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
    const checked = settingsRequest.safeParse(values);
    const listener = startup?.subscription;

    const change = (changes: Partial<SettingsRequest>) => setDraft({ ...values, ...changes });

    const onSave = async (event: FormEvent) => {
        event.preventDefault();

        if (checked.success && (await save(toSettingsPayload(checked.data)))) {
            setDraft(null);
        }
    };

    const onRestore = async () => {
        if (await restore()) {
            setDraft(null);
        }
    };

    return (
        <form aria-label="Subscription" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="p-4">
                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}

                <div className={FIELDS}>
                    {/* Where subscribers fetch from is set with the listener that
                        serves it, in configs/, so it is shown here rather than
                        changed, and given the room an address needs. */}
                    <FilledTextInput
                        id={uriId}
                        label="Subscription URI"
                        className="min-[840px]:col-span-2"
                        readOnly
                        value={base?.uri ?? ""}
                    />

                    {/* A cleared field falls back to the default, as the
                        reference's does, rather than to nothing. */}
                    <FilledTextInput
                        id={updatesId}
                        label="Refresh interval (hours)"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        disabled={isLoading}
                        value={String(values.subUpdates)}
                        onChange={(event) => {
                            const hours = Number(event.target.value);

                            change({ subUpdates: hours > 0 ? hours : 12 });
                        }}
                    />

                    {/* One under the other, each at the head of a row of its
                        own. */}
                    <FilledSwitch
                        label="Base64-encode the subscription"
                        className="min-[600px]:col-start-1"
                        disabled={isLoading}
                        checked={values.subEncode}
                        onCheckedChange={(subEncode) => change({ subEncode })}
                    />
                    <FilledSwitch
                        label="Show the remaining quota and expiry"
                        className="min-[600px]:col-start-1"
                        disabled={isLoading}
                        checked={values.subShowInfo}
                        onCheckedChange={(subShowInfo) => change({ subShowInfo })}
                    />
                </div>

                <Heading as="h3" className={GROUP_HEADING}>
                    Listener, as configs/config.yaml sets it
                </Heading>

                {listener && !listener.enabled && (
                    <InlineMessage variant="warning" className="mb-2">
                        Subscriptions are switched off in configs/config.yaml, so nothing answers on
                        this listener.
                    </InlineMessage>
                )}

                <div className={FIELDS}>
                    <FilledTextInput
                        id={listenId}
                        label="Address"
                        readOnly
                        value={listener?.listen ?? ""}
                    />
                    <FilledTextInput
                        id={portId}
                        label="Port"
                        readOnly
                        value={listener ? String(listener.port) : ""}
                    />
                    <FilledTextInput
                        id={pathId}
                        label="Path"
                        readOnly
                        value={listener?.basePath ?? ""}
                    />
                    <FilledTextInput
                        id={domainId}
                        label="Domain"
                        readOnly
                        value={listener?.domain ?? ""}
                    />
                    <FilledTextInput
                        id={keyId}
                        label="SSL key path"
                        readOnly
                        value={listener?.keyFile ?? ""}
                    />
                    <FilledTextInput
                        id={certificateId}
                        label="SSL certificate path"
                        readOnly
                        value={listener?.certFile ?? ""}
                    />
                </div>

                {!checked.success && (
                    <InlineMessage variant="critical" className="mt-4">
                        {checked.error.issues[0]?.message}
                    </InlineMessage>
                )}

                {/* The API is the authority on what a setting may be, so what it
                    refused is read here rather than beside a field. */}
                {saveError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {saveError.message}
                    </InlineMessage>
                )}
                {resetError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {resetError.message}
                    </InlineMessage>
                )}
            </div>

            {/* Save last, where a dialog keeps it. Putting the options back is
                held back while there are edits to save first, as in the
                reference, and puts back the subscription's alone. */}
            <div className={FOOTER}>
                <Button
                    type="button"
                    loading={isResetting}
                    disabled={isLoading || isChanged}
                    className={RESTORE_BUTTON}
                    onClick={() => void onRestore()}
                >
                    Restore defaults
                </Button>

                <Button
                    type="submit"
                    variant="primary"
                    loading={isSaving}
                    disabled={!isChanged || !checked.success}
                    className={SAVE_BUTTON}
                >
                    Save
                </Button>
            </div>
        </form>
    );
};
