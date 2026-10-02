import { Button, Dialog, InlineMessage } from "@gamecrafters/base-ui/react";

import { useCoreLogs } from "../api/core";

export const CoreLogsDialog = ({
    onClose,
    restartError,
}: {
    onClose: () => void;
    restartError?: string;
}) => {
    const { data, error, isValidating, mutate } = useCoreLogs();

    return (
        <Dialog
            title="sing-box logs"
            onClose={onClose}
            width={760}
            renderFooter={() => (
                <Dialog.Footer key="footer" className="items-center p-2">
                    <Button type="button" loading={isValidating} onClick={() => void mutate()}>
                        Refresh
                    </Button>
                    <Button type="button" onClick={onClose}>
                        Close
                    </Button>
                </Dialog.Footer>
            )}
        >
            <div className="space-y-3 p-4">
                {restartError && <InlineMessage variant="warning">{restartError}</InlineMessage>}
                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
                <pre
                    aria-label="sing-box log output"
                    className="max-h-[60vh] overflow-auto text-left font-mono text-[12px] break-words whitespace-pre-wrap"
                >
                    {data ? data.lines.join("\n") || "No sing-box log entries." : "Loading logs…"}
                </pre>
            </div>
        </Dialog>
    );
};
