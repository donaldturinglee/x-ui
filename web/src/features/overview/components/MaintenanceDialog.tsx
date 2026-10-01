import { ConfirmationDialog, InlineMessage, Stack, Text } from "@gamecrafters/base-ui/react";

import { useSetMaintenance } from "../api";

interface MaintenanceDialogProps {
    // Whether maintenance is on now, which is what the question offers to undo.
    maintenance: boolean;
    onClose: () => void;
}

// Maintenance is not a label the panel wears: turning it on withholds every
// listener from the configuration nodes fetch, so at their next sync the nodes
// are serving nothing and no subscriber can connect. That is worth being asked
// about rather than done on a click, because the effect is delayed by a sync
// interval and is invisible from here. Asked the same way from wherever it is
// switched.
export const MaintenanceDialog = ({ maintenance, onClose }: MaintenanceDialogProps) => {
    const { trigger, isMutating, error } = useSetMaintenance();

    const onDialogClose = async (gesture: string) => {
        if (gesture !== "confirm") {
            onClose();
            return;
        }

        if (await trigger(!maintenance)) {
            onClose();
        }
    };

    return (
        <ConfirmationDialog
            title={maintenance ? "Turn maintenance off" : "Turn maintenance on"}
            confirmButtonContent={maintenance ? "Turn off" : "Turn on"}
            confirmButtonType={maintenance ? "primary" : "danger"}
            confirmButtonLoading={isMutating}
            onClose={onDialogClose}
        >
            <Stack gap="condensed">
                <Text>
                    {maintenance
                        ? "Every listener goes back into the configuration the nodes fetch. Subscribers can connect again from each node's next sync."
                        : "Every listener is withheld from the configuration the nodes fetch. From their next sync the nodes are serving nothing and no subscriber can connect."}
                </Text>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
            </Stack>
        </ConfirmationDialog>
    );
};
