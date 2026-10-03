import { Button, Heading, InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent } from "react";

import { FilledSwitch, FilledTextInput } from "@/components/FilledField";
import {
    fromSettings,
    settingsRequest,
    SUBSCRIPTION_KEYS,
    toSettingsPayload,
    useResetSettings,
    useSaveSettings,
    useSettings,
    type SettingsRequest,
} from "../api";
import { FIELDS, FOOTER, RESTORE_BUTTON, SAVE_BUTTON } from "./layout";
import { SubscriptionServiceSettings } from "./SubscriptionServiceSettings";

const DEFAULTS: SettingsRequest = { subUpdates: 12, subEncode: true, subShowInfo: false };

const SubscriptionContentSettings = () => {
    const id = useId();
    const { data: settings, error: readError, isLoading } = useSettings();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveSettings();
    const {
        trigger: restore,
        isMutating: isResetting,
        error: resetError,
    } = useResetSettings(SUBSCRIPTION_KEYS);
    const [draft, setDraft] = useState<SettingsRequest | null>(null);
    const [savedMessage, setSavedMessage] = useState(false);
    const saved = settings ? fromSettings(settings) : undefined;
    const values = draft ?? saved ?? DEFAULTS;
    const isChanged =
        draft !== null && saved !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
    const checked = settingsRequest.safeParse(values);
    const disabled = isLoading || !settings || isSaving || isResetting;
    const change = (changes: Partial<SettingsRequest>) => {
        setDraft({ ...values, ...changes });
        setSavedMessage(false);
    };
    const onSave = async (event: FormEvent) => {
        event.preventDefault();
        if (
            !disabled &&
            isChanged &&
            checked.success &&
            (await save(toSettingsPayload(checked.data)))
        ) {
            setDraft(null);
            setSavedMessage(true);
        }
    };
    return (
        <form aria-label="Subscription" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="p-4">
                <Heading as="h3" className="mb-2 text-[16px]">
                    Subscription content
                </Heading>
                <Text as="p" className="mb-4 text-[14px] text-[var(--foreground-color-muted)]">
                    These options take effect as soon as you save them.
                </Text>
                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}
                {savedMessage && (
                    <InlineMessage className="mb-4">Subscription content saved.</InlineMessage>
                )}
                <div className={FIELDS}>
                    <FilledTextInput
                        id={`${id}-updates`}
                        label="Refresh interval (hours)"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={168}
                        disabled={disabled}
                        value={String(values.subUpdates)}
                        onChange={(event) => {
                            const hours = Number(event.target.value);
                            change({ subUpdates: hours > 0 ? hours : 12 });
                        }}
                    />
                    <FilledSwitch
                        label="Base64-encode the subscription"
                        className="min-[600px]:col-start-1"
                        disabled={disabled}
                        checked={values.subEncode}
                        onCheckedChange={(subEncode) => change({ subEncode })}
                    />
                    <FilledSwitch
                        label="Show the remaining quota and expiry"
                        className="min-[600px]:col-start-1"
                        disabled={disabled}
                        checked={values.subShowInfo}
                        onCheckedChange={(subShowInfo) => change({ subShowInfo })}
                    />
                </div>
                {!checked.success && (
                    <InlineMessage variant="critical" className="mt-4">
                        {checked.error.issues[0]?.message}
                    </InlineMessage>
                )}
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
            <div className={FOOTER}>
                <Button
                    type="button"
                    loading={isResetting}
                    disabled={disabled || isChanged}
                    className={RESTORE_BUTTON}
                    onClick={() =>
                        void restore().then((result) => {
                            if (result) {
                                setDraft(null);
                                setSavedMessage(false);
                            }
                        })
                    }
                >
                    Restore defaults
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
        </form>
    );
};

export const SubscriptionTab = () => (
    <>
        <SubscriptionContentSettings />
        <SubscriptionServiceSettings />
    </>
);
