import { Button, Dialog, InlineMessage } from "@gamecrafters/base-ui/react";
import { useRef, type RefObject } from "react";

import { useDeleteOutbound, type Outbound } from "../api";

interface DeleteOutboundDialogProps {
    outbound: Outbound;
    // Whether this is the last one. A configuration with listeners and no route
    // out routes nothing, and the API refuses to leave a node in that state.
    isLast: boolean;
    onClose: () => void;
    onDeleted: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const DeleteOutboundDialog = ({
    outbound,
    isLast,
    onClose,
    onDeleted,
    returnFocusRef,
}: DeleteOutboundDialogProps) => {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const { trigger, isMutating, error } = useDeleteOutbound();

    // A refused deletion leaves the question where it is to say so, so it only
    // goes once the route has.
    const confirm = async () => {
        if (await trigger(outbound.id)) {
            onDeleted();
        }
    };

    // The API refuses to take away the last one, and saying so before the
    // attempt is the difference between a considered decision and an error
    // message. The question then says why, and there is only the way out of it.
    return (
        <Dialog
            title="Delete"
            role="alertdialog"
            subtitle={outbound.tag}
            width={440}
            initialFocusRef={cancelRef}
            returnFocusRef={returnFocusRef}
            onClose={() => {
                if (!isMutating) onClose();
            }}
            renderFooter={() => (
                <Dialog.Footer key="footer" className="items-center p-2">
                    <Button
                        variant="danger"
                        loading={isMutating}
                        disabled={isLast || isMutating}
                        onClick={() => void confirm()}
                    >
                        Yes
                    </Button>
                    <Button ref={cancelRef} disabled={isMutating} onClick={onClose}>
                        No
                    </Button>
                </Dialog.Footer>
            )}
        >
            <div className="space-y-3 p-4 text-[14px]">
                <p>
                    {isLast
                        ? "This is the only outbound, and the proxy core will not start without one."
                        : "Are you sure? Rules that detour to it are left with nowhere to send what they match."}
                </p>
                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
            </div>
        </Dialog>
    );
};
