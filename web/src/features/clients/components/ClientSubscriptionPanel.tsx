import {
    Button,
    Clipboard,
    Dialog,
    EmptyState,
    Heading,
    InlineMessage,
    QRCode,
    SkeletonText,
    Stack,
    Text,
} from "@gamecrafters/base-ui/react";
import { LinkDismissRegular } from "@gamecrafters/base-ui-icons";
import { useId, useRef, useState } from "react";

import { FilledSelect } from "@/components/FilledField";

import {
    subscriptionURL,
    useClientSubscriptionInfo,
    useSubscriptionBase,
    type Client,
    type SubscriptionFormat,
} from "../api";

const FORMATS: { value: SubscriptionFormat; label: string }[] = [
    { value: "links", label: "Universal" },
    { value: "clash", label: "Clash / Mihomo" },
    { value: "json", label: "sing-box" },
];

export const ClientSubscriptionPanel = ({ client }: { client: Client }) => {
    const id = useId();
    const [format, setFormat] = useState<SubscriptionFormat>("links");
    const [qrOpen, setQrOpen] = useState(false);
    const enlargeButton = useRef<HTMLButtonElement>(null);
    const subscription = useSubscriptionBase();
    const info = useClientSubscriptionInfo(client.id);
    const available = info.data?.formats[format];
    const label = FORMATS.find(({ value }) => value === format)!.label;
    const url = subscription.data
        ? subscriptionURL(subscription.data.uri, client.name, format)
        : "";

    return (
        <Stack gap="condensed">
            <Heading as="h3" size="small">
                Subscription
            </Heading>

            <FilledSelect
                id={`${id}-format`}
                label="Subscription format"
                value={format}
                className="max-w-sm"
                onChange={(event) => setFormat(event.target.value as SubscriptionFormat)}
            >
                {FORMATS.map(({ value, label: name }) => (
                    <option key={value} value={value}>
                        {name}
                    </option>
                ))}
            </FilledSelect>

            {(subscription.error || info.error) && (
                <InlineMessage variant="critical">
                    {subscription.error?.message ?? info.error?.message}
                </InlineMessage>
            )}
            {(subscription.isLoading || info.isLoading) && <SkeletonText lines={2} />}

            {available && (
                <>
                    {available.omittedProtocols.length > 0 && (
                        <InlineMessage variant="warning">
                            Some assigned nodes are not included in {label}:{" "}
                            {available.omittedProtocols.join(", ")}.
                        </InlineMessage>
                    )}
                    {available.nodeCount === 0 ? (
                        <EmptyState
                            icon={LinkDismissRegular}
                            title={`No nodes for ${label}`}
                            description="Assign a compatible listener or choose another subscription format."
                        />
                    ) : (
                        <Text className="text-xs text-[var(--foreground-color-muted)]">
                            {available.nodeCount} {available.nodeCount === 1 ? "node" : "nodes"}{" "}
                            available
                        </Text>
                    )}
                </>
            )}

            {url && available && available.nodeCount > 0 && (
                <Stack direction="horizontal" align="center" gap="normal" wrap="wrap">
                    <Stack gap="condensed" align="center">
                        <QRCode
                            value={url}
                            size={200}
                            margin={4}
                            color="#000000"
                            background="#ffffff"
                            aria-label={`Subscription link for ${client.name}`}
                            fallback={<Text>Copy the link to import this subscription.</Text>}
                        />
                        <Button ref={enlargeButton} onClick={() => setQrOpen(true)} size="small">
                            Enlarge QR code
                        </Button>
                    </Stack>
                    <Stack.Item grow className="min-w-0">
                        <Stack direction="horizontal" align="center" gap="condensed">
                            <Stack.Item grow className="min-w-0">
                                <Text dir="ltr" className="block font-mono text-xs break-all">
                                    {url}
                                </Text>
                            </Stack.Item>
                            <Clipboard value={url}>
                                <Clipboard.Trigger label="Copy subscription link" size="small" />
                            </Clipboard>
                        </Stack>
                    </Stack.Item>
                </Stack>
            )}

            {subscription.data && !subscription.data.enabled && (
                <InlineMessage variant="warning">
                    Subscriptions are switched off, so nothing answers on this address.
                </InlineMessage>
            )}
            {info.data && !info.data.enabled && (
                <InlineMessage variant="warning">
                    This subscriber is disabled. Enable them before importing the subscription.
                </InlineMessage>
            )}

            {qrOpen && url && available && available.nodeCount > 0 && (
                <Dialog
                    title="Subscription QR code"
                    subtitle={`${client.name} · ${label}`}
                    width="medium"
                    onClose={() => setQrOpen(false)}
                    returnFocusRef={enlargeButton}
                    footerButtons={[{ content: "Close", onClick: () => setQrOpen(false) }]}
                >
                    <Stack gap="normal" align="center">
                        <QRCode
                            value={url}
                            size={320}
                            margin={4}
                            color="#000000"
                            background="#ffffff"
                            className="max-w-full"
                            aria-label={`Large subscription QR code for ${client.name}`}
                            fallback={<Text>Copy the link to import this subscription.</Text>}
                        />
                        <Text dir="ltr" className="text-center font-mono text-xs break-all">
                            {url}
                        </Text>
                        <Clipboard value={url}>
                            <Clipboard.Trigger
                                label="Copy enlarged subscription link"
                                size="small"
                            />
                        </Clipboard>
                    </Stack>
                </Dialog>
            )}
        </Stack>
    );
};
