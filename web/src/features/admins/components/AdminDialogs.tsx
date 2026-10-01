import { Dialog } from "@gamecrafters/base-ui/react";
import type { RefObject } from "react";

import { ChangesTable } from "@/features/audit/components/ChangesTable";
import { TokensPanel } from "@/features/auth/components/TokensPanel";

interface DialogProps {
    onClose: () => void;
    // Closing hands focus back to what opened the dialog, so the page is left
    // where it was.
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// What the reference opens over its admins page rather than leading away from
// it: the change log and a script's tokens, each the panel's own, in a dialog.
// An operator's credentials are a form laid out as the reference's, in a dialog
// of their own.

interface ChangesDialogProps extends DialogProps {
    // Whose changes, or everybody's.
    actor?: string;
}

export const ChangesDialog = ({ actor, onClose, returnFocusRef }: ChangesDialogProps) => {
    return (
        <Dialog
            title={actor ? `Changes by ${actor}` : "Changes"}
            subtitle="Who changed what, operators and background jobs alike."
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="xlarge"
        >
            <ChangesTable actor={actor} hideTitle />
        </Dialog>
    );
};

export const TokensDialog = ({ onClose, returnFocusRef }: DialogProps) => {
    return (
        <Dialog
            title="API tokens"
            subtitle="What a script signs in with, where a browser has a session."
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
        >
            <TokensPanel />
        </Dialog>
    );
};
