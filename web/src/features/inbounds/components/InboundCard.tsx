import { Badge } from "@gamecrafters/base-ui/react";
import {
    CopyRegular,
    DataTrendingRegular,
    DocumentDismissRegular,
    DocumentEditRegular,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { CardAction, CardCount, TaggedCard } from "@/components/TaggedCard";
import { useOnlines } from "@/features/overview/api";

import { clientsOf, hasLink, listenPort, useInboundClients, type Inbound } from "../api";
import { securityLabel, securityOf } from "../api/tls";

import { DeleteInboundDialog } from "./DeleteInboundDialog";

interface InboundCardProps {
    inbound: Inbound;
    // Whether a copy of this listener is being written, which is what the button
    // that asked for it spins for.
    isCloning: boolean;
    onEdit: () => void;
    onClone: () => void;
    onTraffic: () => void;
}

// A listener as the reference draws one: where it binds and how it is served,
// who connects through it and whether anything has lately, and what can be done
// to it along the foot.
//
// Where it binds is written as the record holds it, so a type that binds nothing
// -- tun, redirect -- has nothing there rather than a figure the core never had.
export const InboundCard = ({
    inbound,
    isCloning,
    onEdit,
    onClone,
    onTraffic,
}: InboundCardProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const { data: clientPage } = useInboundClients();
    const { data: onlines } = useOnlines();

    const listen = typeof inbound.listen === "string" ? inbound.listen : "";
    const port = listenPort(inbound);
    const isOnline = (onlines?.inbound ?? []).includes(inbound.tag);

    // Only a type a subscriber can be handed a link for has anybody connecting
    // through it; the rest are listeners the node runs for itself.
    const clients =
        hasLink(inbound) && clientPage ? clientsOf(clientPage.clients, inbound.id) : null;
    const isPartial = clientPage ? clientPage.total > clientPage.clients.length : false;

    // Asked for from the button beside it, so that is where focus goes back to
    // when the answer is no.
    const closeDelete = () => {
        setIsDeleting(false);
        deleteButtonRef.current?.focus();
    };

    return (
        <TaggedCard
            title={inbound.tag}
            subtitle={inbound.type}
            actions={
                <>
                    <CardAction
                        icon={DocumentEditRegular}
                        label={`Edit ${inbound.tag}`}
                        description="Edit"
                        onClick={onEdit}
                    />

                    <CardAction
                        ref={deleteButtonRef}
                        icon={DocumentDismissRegular}
                        label={`Delete ${inbound.tag}`}
                        description="Delete"
                        tone="attention"
                        onClick={() => setIsDeleting(true)}
                    />

                    <CardAction
                        icon={CopyRegular}
                        label={`Clone ${inbound.tag}`}
                        description="Clone"
                        loading={isCloning}
                        onClick={onClone}
                    />

                    {/* The counters say how much has moved and nothing of when,
                        which is the question asked when a subscriber says it
                        stopped working on Tuesday. */}
                    <CardAction
                        icon={DataTrendingRegular}
                        label={`Traffic for ${inbound.tag}`}
                        description="Traffic chart"
                        onClick={onTraffic}
                    />
                </>
            }
            question={isDeleting && <DeleteInboundDialog inbound={inbound} onClose={closeDelete} />}
        >
            <dt>Address</dt>
            <dd>{listen}</dd>

            <dt>Port</dt>
            <dd>{port ?? ""}</dd>

            {/* Read off the block the core terminates with, which the listener
                carries among its own options: in the clear, over TLS or over
                Reality. */}
            <dt>Security</dt>
            <dd>{securityLabel(securityOf(inbound))}</dd>

            {/* A listing that stopped short of every subscriber gives a count
                that is only how many there are at least. */}
            <dt>Clients</dt>
            <dd>
                {clients === null ? (
                    "—"
                ) : (
                    <CardCount
                        names={clients}
                        isPartial={isPartial}
                        none={`0${isPartial ? "+" : ""}`}
                    />
                )}
            </dd>

            {/* Derived from reported traffic rather than from a connection the
                panel holds, so a node that died without saying so drops off on its
                own. */}
            <dt>Online</dt>
            <dd>
                {isOnline ? (
                    <Badge variant="success" className="h-[22px] px-2.5">
                        Online
                    </Badge>
                ) : (
                    "—"
                )}
            </dd>
        </TaggedCard>
    );
};
