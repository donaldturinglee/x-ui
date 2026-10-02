import { Button, Dialog } from "@gamecrafters/base-ui/react";
import type { RefObject } from "react";

import { PLAIN_BUTTON, SAVE_BUTTON } from "./layout";

export const PanelRestartDialog = ({
    targetUrl,
    addressChanged,
    onClose,
    onConfirm,
    returnFocusRef,
}: {
    targetUrl: string;
    addressChanged: boolean;
    onClose: () => void;
    onConfirm: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}) => (
    <Dialog
        title="Restart and apply Panel settings"
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        width={520}
        renderFooter={() => (
            <Dialog.Footer key="footer" className="items-center p-2">
                <Button type="button" className={PLAIN_BUTTON} onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className={SAVE_BUTTON} onClick={onConfirm}>
                    Restart now
                </Button>
            </Dialog.Footer>
        )}
    >
        <div className="space-y-3 p-4 text-[14px]">
            <p>
                The saved settings will be applied. The panel will be briefly unavailable while it
                restarts.
            </p>
            {addressChanged && (
                <>
                    <p>The panel address will change. Open this address after the restart:</p>
                    <p className="font-medium break-all">{targetUrl}</p>
                    <p>If you use a reverse proxy, its public address may stay the same.</p>
                </>
            )}
        </div>
    </Dialog>
);
