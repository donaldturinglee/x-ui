import { CardQuestion } from "@/components/TaggedCard";

import { useDeleteOutbound, type Outbound } from "../api";

interface DeleteOutboundDialogProps {
    outbound: Outbound;
    // Whether this is the last one. A configuration with listeners and no route
    // out routes nothing, and the API refuses to leave a node in that state.
    isLast: boolean;
    onClose: () => void;
}

// Asked on the route's own card, the way the reference asks it.
export const DeleteOutboundDialog = ({ outbound, isLast, onClose }: DeleteOutboundDialogProps) => {
    const { trigger, isMutating, error } = useDeleteOutbound();

    // A refused deletion leaves the question where it is to say so, so it only
    // goes once the route has.
    const confirm = async () => {
        if (await trigger(outbound.id)) {
            onClose();
        }
    };

    // The API refuses to take away the last one, and saying so before the
    // attempt is the difference between a considered decision and an error
    // message. The question then says why, and there is only the way out of it.
    return (
        <CardQuestion
            title="Delete"
            isMutating={isMutating}
            error={error}
            canConfirm={!isLast}
            onConfirm={() => void confirm()}
            onCancel={onClose}
        >
            {isLast
                ? "This is the only outbound, and the proxy core will not start without one."
                : "Are you sure? Rules that detour to it are left with nowhere to send what they match."}
        </CardQuestion>
    );
};
