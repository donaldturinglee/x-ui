import {
    AnchoredOverlay,
    Button,
    Heading,
    InlineMessage,
    Separator,
    Text,
} from "@gamecrafters/base-ui/react";
import { useId, useRef, type RefObject } from "react";

import { useDeleteClient, type Client } from "../api";

interface DeleteClientDialogProps {
    client: Client;
    // The button on the row that asked, which the question stands over.
    anchorRef: RefObject<HTMLButtonElement | null>;
    onClose: () => void;
}

// Asked over the button that asked for it rather than in the middle of the page,
// which is where the reference asks it: the row it is about stays in view beside
// it, so which subscriber is going is never in doubt.
export const DeleteClientDialog = ({ client, anchorRef, onClose }: DeleteClientDialogProps) => {
    const titleId = useId();
    const descriptionId = useId();
    const cancelRef = useRef<HTMLButtonElement>(null);
    const { trigger, isMutating, error } = useDeleteClient();

    // A refused deletion leaves the question where it is to say so, so it only
    // goes once the subscriber has.
    const confirm = async () => {
        if (await trigger(client.id)) {
            onClose();
        }
    };

    return (
        <AnchoredOverlay
            open
            renderAnchor={null}
            anchorRef={anchorRef}
            side="outside-top"
            align="center"
            onClose={onClose}
            // What is being asked for cannot be undone, so the way out of it is
            // what the question opens on rather than the way through.
            focusTrapSettings={{ initialFocusRef: cancelRef, returnFocusRef: anchorRef }}
            overlayProps={{
                role: "alertdialog",
                "aria-labelledby": titleId,
                "aria-describedby": descriptionId,
            }}
        >
            <div className="w-60">
                <Heading
                    as="h2"
                    id={titleId}
                    className="px-4 py-2.5 text-[22px] leading-7 font-normal"
                >
                    Delete
                </Heading>

                <Separator />

                {/* Disabling keeps the subscriber and their traffic history;
                    deleting takes both. Saying which of the two this is is what
                    stops a quota dispute being settled by having no record. */}
                <Text
                    as="p"
                    id={descriptionId}
                    className="m-0 p-4 text-[14px] leading-5 tracking-[0.25px]"
                >
                    Are you sure? {client.name} goes with their traffic history, and their link
                    stops working.
                </Text>

                {error && (
                    <InlineMessage variant="critical" className="px-4 pb-2">
                        {error.message}
                    </InlineMessage>
                )}

                {/* Outlined in the colour of what each answer does, rather than
                    one of them filled in as the way through. */}
                <div className="flex min-h-[52px] items-center gap-2 p-2">
                    <Button
                        variant="danger"
                        loading={isMutating}
                        className="h-9 min-w-16 rounded-[4px] border-[var(--border-color-danger-emphasis)] bg-transparent px-2 text-[14px]"
                        onClick={confirm}
                    >
                        Yes
                    </Button>
                    <Button
                        ref={cancelRef}
                        disabled={isMutating}
                        className="h-9 min-w-16 rounded-[4px] border-[var(--border-color-success-emphasis)] bg-transparent px-2 text-[14px] text-[var(--foreground-color-success)]"
                        onClick={onClose}
                    >
                        No
                    </Button>
                </div>
            </div>
        </AnchoredOverlay>
    );
};
