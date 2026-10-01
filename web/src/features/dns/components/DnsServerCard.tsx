import { DocumentDismissRegular, DocumentEditRegular } from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { CardAction, CardQuestion, TaggedCard } from "@/components/TaggedCard";

import { serverAddress, serverTls, type DnsServer } from "../api";

interface DnsServerCardProps {
    server: DnsServer;
    onEdit: () => void;
    onDelete: () => void;
}

// A server as the reference draws one: where it is asked and whether it is asked
// over TLS. A type that is not asked over the network -- the node's own resolver,
// a hosts file -- has neither an address nor a port.
export const DnsServerCard = ({ server, onEdit, onDelete }: DnsServerCardProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const { address, port } = serverAddress(server);
    const tls = serverTls(server);

    // Asked for from the button beside it, so that is where focus goes back to
    // when the answer is no.
    const closeDelete = () => {
        setIsDeleting(false);
        deleteButtonRef.current?.focus();
    };

    return (
        <TaggedCard
            title={server.tag}
            subtitle={server.type}
            actions={
                <>
                    <CardAction
                        icon={DocumentEditRegular}
                        label={`Edit ${server.tag}`}
                        description="Edit"
                        onClick={onEdit}
                    />

                    <CardAction
                        ref={deleteButtonRef}
                        icon={DocumentDismissRegular}
                        label={`Delete ${server.tag}`}
                        description="Delete"
                        tone="attention"
                        onClick={() => setIsDeleting(true)}
                    />
                </>
            }
            question={
                // Taken off the page rather than out of the document, so there is
                // nothing to wait on: the page's Save is what writes it.
                isDeleting && (
                    <CardQuestion
                        title="Delete"
                        isMutating={false}
                        onConfirm={onDelete}
                        onCancel={closeDelete}
                    >
                        Are you sure? Rules that send queries to it are left with nowhere to send
                        them.
                    </CardQuestion>
                )
            }
        >
            <dt>Server</dt>
            <dd>{address ?? "—"}</dd>

            <dt>Port</dt>
            <dd>{port ?? "—"}</dd>

            {/* Said only of a server that carries a TLS block at all: one that
                has none is not the same as one that has it switched off. */}
            <dt>TLS</dt>
            <dd>{tls === "enabled" ? "Enabled" : tls === "disabled" ? "Disabled" : "—"}</dd>
        </TaggedCard>
    );
};
