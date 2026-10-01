import { Heading, InlineMessage, List, Stack } from "@gamecrafters/base-ui/react";
import { useId, useRef, useState } from "react";

import { AddButton } from "@/components/AddButton";
import { TaggedCards } from "@/components/TaggedCard";
import { TrafficDialog } from "@/features/diagnostics/components/TrafficDialog";

import { cloneInbound, useCreateInbound, useInbounds, type Inbound } from "../api";

import { CreateInboundDialog } from "./CreateInboundDialog";
import { EditInboundDialog } from "./EditInboundDialog";
import { InboundCard } from "./InboundCard";

// The listeners as the reference lays them out: the one button that adds another,
// centred over a grid of cards that is six across on a wide screen, four on a
// laptop, three on a tablet and one on a phone.
export const InboundsGrid = () => {
    const titleId = useId();
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<Inbound | null>(null);
    const [showingTraffic, setShowingTraffic] = useState<Inbound | null>(null);
    const [cloning, setCloning] = useState<Inbound | null>(null);
    const { data: inbounds, error, isLoading } = useInbounds();
    const { trigger: create, error: cloneError } = useCreateInbound();

    // Written straight away rather than through the form, the way the reference
    // does it: a copy is only ever the listener it came from under a new tag and
    // port, and either of those can be changed afterwards like any other.
    const clone = async (inbound: Inbound) => {
        const takenTags = (inbounds ?? []).map((other) => other.tag);

        setCloning(inbound);
        await create(cloneInbound(inbound, takenTags));
        setCloning(null);
    };

    // A dialog is mounted only while it is open, so what was typed into one is
    // gone by the time it is opened again rather than left half filled in.
    return (
        <>
            <Stack gap="condensed">
                {/* Named for whatever reads the page out, where a grid of cards is
                    otherwise a list of tags with nothing to say what they are. */}
                <Heading as="h2" id={titleId} className="sr-only">
                    Listeners
                </Heading>

                <div className="flex justify-center">
                    <AddButton
                        ref={addButtonRef}
                        label="Add inbound"
                        onClick={() => setIsCreateOpen(true)}
                    />
                </div>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                {/* A copy is written without a dialog of its own to say what the
                    API made of it, so a refusal is said here, above the cards. */}
                {cloneError && (
                    <InlineMessage variant="critical">{cloneError.message}</InlineMessage>
                )}

                <TaggedCards labelledBy={titleId} isLoading={isLoading}>
                    {inbounds?.map((inbound) => (
                        <List.Item key={inbound.id}>
                            <InboundCard
                                inbound={inbound}
                                isCloning={cloning?.id === inbound.id}
                                onEdit={() => setEditing(inbound)}
                                onClone={() => void clone(inbound)}
                                onTraffic={() => setShowingTraffic(inbound)}
                            />
                        </List.Item>
                    ))}
                </TaggedCards>
            </Stack>

            {isCreateOpen && (
                <CreateInboundDialog
                    onClose={() => setIsCreateOpen(false)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {/* What these were opened from is a button on a card, and the card goes
                when the listener does, so focus is handed back to what adds them
                rather than to something that may not be there. */}
            {editing && (
                <EditInboundDialog
                    inbound={editing}
                    onClose={() => setEditing(null)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {showingTraffic && (
                <TrafficDialog
                    resource="inbound"
                    tag={showingTraffic.tag}
                    onClose={() => setShowingTraffic(null)}
                    returnFocusRef={addButtonRef}
                />
            )}
        </>
    );
};
