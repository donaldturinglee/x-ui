import { Button, InlineMessage, Text } from "@gamecrafters/base-ui/react";
import { useState } from "react";

import {
    httpClientsOf,
    isHttpClientsChanged,
    withHttpClients,
    type HttpClient,
} from "@/features/basics/api";
import { HttpClients } from "@/features/basics/components/HttpClients";
import { toDocument, useBaseConfig, useSaveBaseConfig } from "@/features/config/api";
import { useOutbounds } from "@/features/outbounds/api";

import { FOOTER, SAVE_BUTTON } from "./layout";

// The named clients used for remote downloads are saved apart from NTP. The
// latest base document supplies every other key when this tab saves its list.
export const HttpClientsTab = () => {
    const { data: config, error: readError } = useBaseConfig();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveBaseConfig();
    const { data: outbounds } = useOutbounds();

    const [draft, setDraft] = useState<HttpClient[] | null>(null);
    const clients = draft ?? httpClientsOf(config);
    const outboundTags = (outbounds ?? []).map((outbound) => outbound.tag);
    const isReady = config !== undefined;
    const isChanged = draft !== null && isHttpClientsChanged(config, draft);

    const onSave = async () => {
        if (!config) {
            return;
        }

        if (await save({ document: toDocument(withHttpClients(config, clients)) })) {
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
                    Named HTTP clients used by the node to download remote resources.
                </Text>

                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}

                <HttpClients
                    clients={clients}
                    outboundTags={outboundTags}
                    disabled={!isReady}
                    onChange={setDraft}
                />

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
