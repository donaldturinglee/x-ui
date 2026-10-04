import {
    Clipboard,
    Dialog,
    EmptyState,
    Heading,
    InlineMessage,
    SkeletonText,
    Stack,
    Text,
} from "@gamecrafters/base-ui/react";
import { LinkDismissRegular } from "@gamecrafters/base-ui-icons";
import type { RefObject } from "react";

import { useClientLinks, type Client } from "../api";

import { ClientSubscriptionPanel } from "./ClientSubscriptionPanel";

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
                <ClientSubscriptionPanel client={client} />

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

                                    <Clipboard value={link}>
                                        <Clipboard.Trigger label="Copy link" size="small" />
                                    </Clipboard>
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
