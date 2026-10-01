import { CardQuestion } from "@/components/TaggedCard";

import { useDeleteInbound, type Inbound } from "../api";

interface DeleteInboundDialogProps {
    inbound: Inbound;
    onClose: () => void;
}

// Asked on the listener's own card, the way the reference asks it.
export const DeleteInboundDialog = ({ inbound, onClose }: DeleteInboundDialogProps) => {
    const { trigger, isMutating, error } = useDeleteInbound();

    // A refused deletion leaves the question where it is to say so, so it only
    // goes once the listener has.
    const confirm = async () => {
        if (await trigger(inbound.id)) {
            onClose();
        }
    };

    return (
        <CardQuestion
            title="Delete"
            isMutating={isMutating}
            error={error}
            onConfirm={() => void confirm()}
            onCancel={onClose}
        >
            {/* The API takes the listener out of every subscriber that named it,
                in the same transaction. Saying so here is the difference between
                an operator knowing their subscriptions just got one node shorter
                and finding out from a support ticket. */}
            Are you sure? Every subscription that includes it comes back one node short.
        </CardQuestion>
    );
};
