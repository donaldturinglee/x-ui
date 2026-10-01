import { ConfirmationDialog, InlineMessage, Stack, Text } from "@gamecrafters/base-ui/react";

import { useResetAllTraffic } from "../api";

interface ResetAllTrafficDialogProps {
    onClose: () => void;
}

// The one subscriber's reset, for all of them at once. Asked about rather than
// done on the click for the same reason that one is: everybody held offline for
// running out comes back online from this, which is a billing decision for the
// whole panel rather than a tidy-up.
export const ResetAllTrafficDialog = ({ onClose }: ResetAllTrafficDialogProps) => {
    const { trigger, isMutating, error } = useResetAllTraffic();

    // Confirming is one of the ways the dialog closes rather than something that
    // happens before it, so what was asked for is read off the way it went.
    const onDialogClose = async (gesture: string) => {
        if (gesture !== "confirm") {
            onClose();
            return;
        }

        if (await trigger()) {
            onClose();
        }
    };

    return (
        <ConfirmationDialog
            title="Reset all traffic"
            confirmButtonContent="Reset"
            confirmButtonType="danger"
            confirmButtonLoading={isMutating}
            // Every subscriber at once is not something to land on by pressing
            // Enter, so the dialog opens on the way out of it.
            overrideButtonFocus="cancel"
            onClose={onDialogClose}
        >
            <Stack gap="condensed">
                {/* Nothing is lost, which is the part worth saying: the figures
                    move rather than disappearing, so a quota dispute can still be
                    settled afterwards. */}
                <Text>
                    Every subscriber starts a new period at zero. What each of them has used is
                    added to their lifetime total rather than discarded, and anyone held offline for
                    running out comes back online.
                </Text>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
            </Stack>
        </ConfirmationDialog>
    );
};
