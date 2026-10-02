import { ConfirmationDialog, InlineMessage, Stack, Text } from "@gamecrafters/base-ui/react";

export const CoreRestartDialog = ({
    onClose,
    onConfirm,
    isScheduling,
    error,
}: {
    onClose: () => void;
    onConfirm: () => Promise<void>;
    isScheduling: boolean;
    error?: Error;
}) => (
    <ConfirmationDialog
        title="Restart sing-box on this server"
        confirmButtonContent="Restart now"
        confirmButtonType="danger"
        confirmButtonLoading={isScheduling}
        onClose={async (gesture) => {
            if (gesture === "confirm") await onConfirm();
            else onClose();
        }}
    >
        <Stack gap="condensed">
            <Text>
                Existing proxy connections will be closed. Subscribers can reconnect when sing-box
                is ready. The panel will remain available.
            </Text>
            {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
        </Stack>
    </ConfirmationDialog>
);
