import { Button, Dialog } from "@gamecrafters/base-ui/react";
import type { RefObject } from "react";

import { PLAIN_BUTTON, SAVE_BUTTON } from "./layout";
import type { SettingsScope } from "../api/panel";
import type { SettingsChange } from "./startupChanges";

export const PanelRestartDialog = ({
    targetUrl,
    addressChanged,
    onClose,
    onConfirm,
    returnFocusRef,
    scopes = ["panel"],
    changes = [],
    subscriptionUri,
}: {
    targetUrl: string;
    addressChanged: boolean;
    onClose: () => void;
    onConfirm: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
    scopes?: SettingsScope[];
    changes?: SettingsChange[];
    subscriptionUri?: string;
}) => (
    <Dialog
        title={
            scopes.includes("subscription")
                ? "Restart and apply settings"
                : "Restart and apply Panel settings"
        }
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
            <p>
                Apply saved changes to:{" "}
                {scopes
                    .map((scope) => (scope === "panel" ? "Panel" : "Subscription"))
                    .join(" and ")}
                .
            </p>
            {changes.length > 0 && (
                <dl className="max-h-64 space-y-2 overflow-y-auto">
                    {changes.map((change) => (
                        <div key={`${change.scope}-${change.label}`}>
                            <dt className="font-medium">
                                {change.scope}: {change.label}
                            </dt>
                            <dd className="break-all">
                                {change.before} → {change.after}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {subscriptionUri && scopes.includes("subscription") && (
                <p className="break-all">Saved subscription URI: {subscriptionUri}</p>
            )}
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
