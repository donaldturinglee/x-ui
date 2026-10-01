import { InlineMessage, SkeletonText, Text } from "@gamecrafters/base-ui/react";

import { useClientLinks, type Client } from "../api";

interface ClientLinksPanelProps {
    // The saved subscriber whose links these are.
    client: Client;
}

// The last of a saved subscriber's tabs: their links, numbered, one to a row, as
// the reference lists them. The API builds them on read from the listeners the
// subscriber is given.
//
// The reference also keeps links from elsewhere -- another node, another
// subscription -- beside them; the API has nowhere to keep those, so they are
// not offered.
export const ClientLinksPanel = ({ client }: ClientLinksPanelProps) => {
    const { data: links, error, isLoading } = useClientLinks(client.id);

    return (
        <div className="flex flex-col gap-2 py-2">
            {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
            {isLoading && <SkeletonText lines={2} />}
            {links?.length === 0 && (
                <Text as="p" className="m-0 text-[var(--foreground-color-muted)]">
                    No links: {client.name} is not given a listener a client application can dial.
                </Text>
            )}
            {links?.map((link, index) => (
                <div key={link} className="flex gap-4 text-[16px] leading-6">
                    <span>{index + 1}</span>
                    <span dir="ltr" className="min-w-0 break-all">
                        {link}
                    </span>
                </div>
            ))}
        </div>
    );
};
