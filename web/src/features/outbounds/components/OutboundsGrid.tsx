import { Heading, InlineMessage, List, Stack } from "@gamecrafters/base-ui/react";
import { useId, useRef, useState } from "react";

import { AddButton } from "@/components/AddButton";
import { TaggedCards } from "@/components/TaggedCard";
import { TrafficDialog } from "@/features/diagnostics/components/TrafficDialog";

import { useOutbounds, type Outbound } from "../api";

import { CreateOutboundDialog } from "./CreateOutboundDialog";
import { EditOutboundDialog } from "./EditOutboundDialog";
import { OutboundCard } from "./OutboundCard";

// The routes out as the reference lays them out: the button that adds another,
// centred over a grid of cards. A WireGuard tunnel is one of them, written into
// the endpoints of the generated configuration by the API rather than here.
//
// The reference also imports a batch of routes from links and measures every one
// at once from beside it. The API takes routes one at a time and the panel runs
// no proxy core to measure with, so neither is offered.
export const OutboundsGrid = () => {
    const titleId = useId();
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<Outbound | null>(null);
    const [showingTraffic, setShowingTraffic] = useState<Outbound | null>(null);
    const { data: outbounds, error, isLoading } = useOutbounds();

    // A dialog is mounted only while it is open, so what was typed into one is
    // gone by the time it is opened again rather than left half filled in.
    return (
        <>
            <Stack gap="condensed">
                <Heading as="h2" id={titleId} className="sr-only">
                    Routes out
                </Heading>

                <div className="flex justify-center">
                    <AddButton
                        ref={addButtonRef}
                        label="Add Outbound"
                        onClick={() => setIsCreateOpen(true)}
                    />
                </div>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                <TaggedCards labelledBy={titleId} isLoading={isLoading}>
                    {outbounds?.map((outbound) => (
                        <List.Item key={outbound.id}>
                            <OutboundCard
                                outbound={outbound}
                                isLast={outbounds.length === 1}
                                onEdit={() => setEditing(outbound)}
                                onTraffic={() => setShowingTraffic(outbound)}
                            />
                        </List.Item>
                    ))}
                </TaggedCards>
            </Stack>

            {isCreateOpen && (
                <CreateOutboundDialog
                    onClose={() => setIsCreateOpen(false)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {/* What these were opened from is a button on a card, and the card goes
                when the route does, so focus is handed back to what adds them
                rather than to something that may not be there. */}
            {editing && (
                <EditOutboundDialog
                    outbound={editing}
                    onClose={() => setEditing(null)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {showingTraffic && (
                <TrafficDialog
                    resource="outbound"
                    tag={showingTraffic.tag}
                    onClose={() => setShowingTraffic(null)}
                    returnFocusRef={addButtonRef}
                />
            )}
        </>
    );
};
