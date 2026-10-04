import { useState } from "react";
import { useSWRConfig } from "swr";

import {
    fromSettings,
    settingsRequest,
    toSettingsPayload,
    useSaveSettings,
    useSettings,
    useStartupSettings,
    type SettingsRequest,
} from "../api";
import { PANEL_SETTINGS_KEY } from "../api/panel";
import {
    fromSubscriptionSettings,
    subscriptionSettingsRequest,
    useSaveSubscriptionSettings,
    useSubscriptionSettings,
    type SubscriptionServiceForm,
} from "../api/subscription";
import { useSettingsApplication } from "./useSettingsApplication";

type SubscriptionForm = SettingsRequest & SubscriptionServiceForm;

const DEFAULT_CONTENT: SettingsRequest = { subUpdates: 12, subEncode: true, subShowInfo: false };
const DEFAULT_SERVICE: SubscriptionServiceForm = {
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
const SERVICE_KEYS = Object.keys(DEFAULT_SERVICE) as (keyof SubscriptionServiceForm)[];

export const useSubscriptionForm = () => {
    const { mutate } = useSWRConfig();
    const contents = useSettings();
    const service = useSubscriptionSettings();
    const { data: startup } = useStartupSettings();
    const contentSave = useSaveSettings();
    const serviceSave = useSaveSubscriptionSettings();
    const application = useSettingsApplication(service.data, "subscription");
    const [draft, setDraft] = useState<{ values: SubscriptionForm; revision: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState<"saved" | "defaults" | null>(null);
    const [partialSave, setPartialSave] = useState(false);
    const saved: SubscriptionForm = {
        ...(contents.data ? fromSettings(contents.data) : DEFAULT_CONTENT),
        ...(service.data ? fromSubscriptionSettings(service.data.saved) : DEFAULT_SERVICE),
    };
    const values = draft?.values ?? saved;
    const contentChanged =
        draft !== null &&
        (values.subUpdates !== saved.subUpdates ||
            values.subEncode !== saved.subEncode ||
            values.subShowInfo !== saved.subShowInfo);
    const serviceChanged = draft !== null && SERVICE_KEYS.some((key) => values[key] !== saved[key]);
    const isChanged = contentChanged || serviceChanged;
    const checkedContent = settingsRequest.safeParse(values);
    const checkedService = subscriptionSettingsRequest.safeParse(values);
    const isSaving = submitting || contentSave.isMutating || serviceSave.isMutating;
    const disabled =
        contents.isLoading ||
        service.isLoading ||
        !contents.data ||
        !service.data ||
        isSaving ||
        application.isRestarting;
    const resetMessages = () => {
        contentSave.reset();
        serviceSave.reset();
        setMessage(null);
        setPartialSave(false);
    };
    const change = <Key extends keyof SubscriptionForm>(key: Key, value: SubscriptionForm[Key]) => {
        if (disabled || !service.data) return;
        setDraft({
            values: { ...values, [key]: value },
            revision: draft?.revision ?? service.data.revision,
        });
        resetMessages();
    };
    const save = async () => {
        if (
            disabled ||
            !isChanged ||
            !draft ||
            !checkedContent.success ||
            !checkedService.success
        ) {
            return;
        }
        resetMessages();
        setSubmitting(true);
        let savedService = false;
        try {
            // A revision conflict must not apply the other changes from a
            // stale form. Keep successful writes as the baseline for retries.
            if (serviceChanged) {
                const result = await serviceSave.trigger({
                    revision: draft.revision,
                    values: checkedService.data,
                });
                if (!result) return;
                savedService = true;
                setDraft({
                    values: { ...draft.values, ...fromSubscriptionSettings(result.saved) },
                    revision: result.revision,
                });
                void mutate(PANEL_SETTINGS_KEY);
            }
            if (contentChanged) {
                const result = await contentSave.trigger(toSettingsPayload(checkedContent.data));
                if (!result) {
                    setPartialSave(savedService);
                    return;
                }
            }
            setDraft(null);
            setMessage("saved");
        } finally {
            setSubmitting(false);
        }
    };
    const discard = () => {
        if (disabled) return;
        setDraft(null);
        resetMessages();
        void Promise.allSettled([contents.mutate(), service.mutate()]);
    };
    const restoreDefaults = () => {
        if (disabled || !service.data) return;
        const controlled = Object.fromEntries(
            Object.keys(service.data.overrides).map((key) => [
                key,
                saved[key as keyof SubscriptionServiceForm],
            ]),
        );
        // A locked SSL path also needs its matching path to remain valid.
        if (service.data.overrides.certFile || service.data.overrides.keyFile) {
            controlled.certFile = saved.certFile;
            controlled.keyFile = saved.keyFile;
        }
        setDraft({
            values: { ...DEFAULT_CONTENT, ...DEFAULT_SERVICE, ...controlled },
            revision: draft?.revision ?? service.data.revision,
        });
        resetMessages();
        setMessage("defaults");
    };

    return {
        data: service.data,
        startup,
        application,
        values,
        isChanged,
        hasDraft: draft !== null,
        disabled,
        isSaving,
        checkedContent,
        checkedService,
        message,
        partialSave,
        readError: contents.error ?? service.error,
        saveError: serviceSave.error ?? contentSave.error,
        change,
        save,
        discard,
        restoreDefaults,
    };
};
