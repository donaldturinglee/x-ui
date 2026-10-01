import {
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
import type { RefObject } from "react";

import { subscriptionURL, useClientLinks, useSubscriptionBase, type Client } from "../api";

interface ClientLinksDialogProps {
    client: Client;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// What a subscriber is actually given. One link per listener they are assigned
// to, per address that listener publishes, built by the API on read — so a
// change to a listener shows up here without anything being regenerated.
export const ClientLinksDialog = ({ client, onClose, returnFocusRef }: ClientLinksDialogProps) => {
    const { data: links, error, isLoading } = useClientLinks(client.id);
    const { data: subscription } = useSubscriptionBase();

    return (
        <Dialog
            title="Connection links"
            subtitle={client.name}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
            footerButtons={[{ content: "Close", onClick: onClose }]}
        >
            <Stack gap="normal">
                {/* The one link worth handing over. A client application given
                    this fetches the list below for itself and keeps it current;
                    the individual links are for pasting one node somewhere by
                    hand. */}
                {subscription && (
                    <Stack gap="condensed">
                        <Heading as="h3" size="small">
                            Subscription
                        </Heading>

                        <Stack direction="horizontal" align="center" gap="normal" wrap="wrap">
                            {/* Scanned rather than copied: a subscriber is
                                usually holding the phone the subscription is
                                for, and reading a URL of this length off a
                                screen is how a character goes missing. */}
                            <QRCode
                                value={subscriptionURL(subscription.uri, client.name)}
                                size={128}
                                aria-label={`Subscription link for ${client.name}`}
                            />

                            <Stack.Item grow className="min-w-0">
                                <Stack direction="horizontal" align="center" gap="condensed">
                                    <Stack.Item grow className="min-w-0">
                                        <Text className="block truncate font-mono text-xs">
                                            {subscriptionURL(subscription.uri, client.name)}
                                        </Text>
                                    </Stack.Item>

                                    <Clipboard
                                        value={subscriptionURL(subscription.uri, client.name)}
                                        aria-label="Copy subscription link"
                                    />
                                </Stack>
                            </Stack.Item>
                        </Stack>

                        {!subscription.enabled && (
                            <InlineMessage variant="warning">
                                Subscriptions are switched off, so nothing answers on this address.
                            </InlineMessage>
                        )}
                    </Stack>
                )}

                <Heading as="h3" size="small">
                    Individual nodes
                </Heading>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                {isLoading && <SkeletonText lines={4} />}

                {links &&
                    (links.length ? (
                        <Stack gap="condensed">
                            {links.map((link) => (
                                <Stack
                                    key={link}
                                    direction="horizontal"
                                    align="center"
                                    gap="condensed"
                                >
                                    {/* A link is long and is meant to be taken
                                        rather than read, so it is truncated to
                                        one line and copied whole. */}
                                    <Stack.Item grow className="min-w-0">
                                        <Text className="block truncate font-mono text-xs">
                                            {link}
                                        </Text>
                                    </Stack.Item>

                                    <Clipboard value={link} aria-label="Copy link" />
                                </Stack>
                            ))}
                        </Stack>
                    ) : (
                        <EmptyState
                            icon={LinkDismissRegular}
                            title="No links"
                            description="This subscriber is not assigned to any listener a client application can dial."
                        />
                    ))}
            </Stack>
        </Dialog>
    );
};
