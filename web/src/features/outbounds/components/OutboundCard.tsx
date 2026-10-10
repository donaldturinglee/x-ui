import { Badge, IconButton, Tooltip } from "@gamecrafters/base-ui/react";
import {
    DataTrendingRegular,
    DocumentDismissRegular,
    DocumentEditRegular,
    DismissCircleRegular,
    TopSpeedRegular,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { CardAction, TaggedCard } from "@/components/TaggedCard";
import { useOnlines } from "@/features/overview/api";

import { destination, refusesAll, tlsState, WIREGUARD, type Outbound } from "../api";
import type { OutboundCheckState } from "../api/useOutboundChecks";

import { DeleteOutboundDialog } from "./DeleteOutboundDialog";

interface OutboundCardProps {
    outbound: Outbound;
    // Whether this is the only outbound, which the API refuses to take away.
    isLast: boolean;
    onEdit: () => void;
    onTraffic: () => void;
    check?: OutboundCheckState;
    checkDisabled?: boolean;
    onCheck: () => void;
}

// A route out as the reference draws one: where it sends traffic, whether it
// wraps it in TLS on the way, and whether anything has gone out through it
// lately. Delay measures an HTTP probe routed through this outbound by the core.
//
// A type that sends traffic nowhere -- direct lets it out as it is, block drops
// it -- has neither a server nor a port. A WireGuard route's are its peer's.
export const OutboundCard = ({
    outbound,
    isLast,
    onEdit,
    onTraffic,
    check,
    checkDisabled,
    onCheck,
}: OutboundCardProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const { data: onlines } = useOnlines();

    const { server, port } = destination(outbound);
    const tls = tlsState(outbound);
    const isOnline = (onlines?.outbound ?? []).includes(outbound.tag);
    const isBlock = refusesAll(outbound.type);

    // Asked for from the button beside it, so that is where focus goes back to
    // when the answer is no.
    const closeDelete = () => {
        setIsDeleting(false);
        deleteButtonRef.current?.focus();
    };

    return (
        <TaggedCard
            title={outbound.tag}
            subtitle={outbound.type === WIREGUARD ? "WireGuard" : outbound.type}
            actions={
                <>
                    <CardAction
                        icon={DocumentEditRegular}
                        label={`Edit ${outbound.tag}`}
                        description="Edit"
                        onClick={onEdit}
                    />

                    <CardAction
                        ref={deleteButtonRef}
                        icon={DocumentDismissRegular}
                        label={`Delete ${outbound.tag}`}
                        description="Delete"
                        tone="attention"
                        onClick={() => setIsDeleting(true)}
                    />

                    <CardAction
                        icon={DataTrendingRegular}
                        label={`Traffic for ${outbound.tag}`}
                        description="Traffic chart"
                        onClick={onTraffic}
                    />
                </>
            }
            question={
                isDeleting && (
                    <DeleteOutboundDialog
                        outbound={outbound}
                        isLast={isLast}
                        onClose={closeDelete}
                    />
                )
            }
        >
            <dt>Address</dt>
            <dd>{server ?? "—"}</dd>

            <dt>Port</dt>
            <dd>{port ?? "—"}</dd>

            {/* Said only of a route that carries a TLS block at all: one that
                has none is not the same as one that has it switched off. */}
            <dt>TLS</dt>
            <dd>{tls === "enabled" ? "Enabled" : tls === "disabled" ? "Disabled" : "—"}</dd>

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
            <dt className="flex items-center gap-1">
                Delay
                {!isBlock && (
                    <Tooltip type="description" text="Check connectivity through this outbound">
                        <IconButton
                            icon={<TopSpeedRegular size={20} />}
                            aria-label={`Check ${outbound.tag}`}
                            loading={check?.loading}
                            loadingAnnouncement={`Checking ${outbound.tag}`}
                            disabled={checkDisabled || check?.loading}
                            variant="invisible"
                            className="size-6 rounded-full"
                            onClick={onCheck}
                        />
                    </Tooltip>
                )}
            </dt>
            <dd aria-live="polite">
                {isBlock ? (
                    <Tooltip type="description" text="Block outbounds do not accept connections.">
                        <Badge
                            as="button"
                            type="button"
                            variant="invisible"
                            className="h-[22px] px-0"
                        >
                            N/A
                        </Badge>
                    </Tooltip>
                ) : check?.loading ? (
                    <span className="sr-only">Checking</span>
                ) : check?.result?.ok ? (
                    <Badge variant="success" className="h-[22px] px-2">
                        {check.result.delay} ms
                    </Badge>
                ) : check?.result ? (
                    <Tooltip
                        type="description"
                        text={check.result.error || "Connection check failed."}
                    >
                        <Badge
                            as="button"
                            type="button"
                            variant="danger"
                            leadingVisual={<DismissCircleRegular size={14} />}
                            aria-label={`Check failed for ${outbound.tag}`}
                            className="h-[22px] gap-1 px-2"
                        >
                            Failed
                        </Badge>
                    </Tooltip>
                ) : (
                    "—"
                )}
            </dd>
        </TaggedCard>
    );
};
