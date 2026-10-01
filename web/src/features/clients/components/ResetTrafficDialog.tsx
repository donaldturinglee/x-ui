import { ConfirmationDialog, InlineMessage, Stack, Text } from "@gamecrafters/base-ui/react";

import { formatBytes } from "@/features/overview/api";

import { usedBytes, useResetClientTraffic, type Client } from "../api";

interface ResetTrafficDialogProps {
    client: Client;
    onClose: () => void;
}

// Asked about rather than done on the click: a subscriber who was disabled for
// running out comes back online from this, which is a billing decision and not
// a tidy-up.
export const ResetTrafficDialog = ({ client, onClose }: ResetTrafficDialogProps) => {
    const { trigger, isMutating, error } = useResetClientTraffic();

    // Confirming is one of the ways the dialog closes rather than something that
    // happens before it, so what was asked for is read off the way it went.
    const onDialogClose = async (gesture: string) => {
        if (gesture !== "confirm") {
            onClose();
            return;
        }

        if (await trigger(client.id)) {
            onClose();
        }
    };

    return (
        <ConfirmationDialog
            title="Reset traffic"
            confirmButtonContent="Reset"
            confirmButtonType="primary"
            confirmButtonLoading={isMutating}
            onClose={onDialogClose}
        >
            <Stack gap="condensed">
                {/* Nothing is lost, which is the part worth saying: the figure
                    moves rather than disappearing, so a quota dispute can still
                    be settled afterwards. */}
                <Text>
                    {client.name} starts a new period at zero. The {formatBytes(usedBytes(client))}{" "}
                    they have used is added to their lifetime total rather than discarded, and a
                    subscriber held offline for running out comes back online.
                </Text>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
            </Stack>
        </ConfirmationDialog>
    );
};
