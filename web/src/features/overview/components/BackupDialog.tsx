import {
    Button,
    Checkbox,
    Dialog,
    FormControl,
    InlineMessage,
    Stack,
} from "@gamecrafters/base-ui/react";
import { useId, useRef, useState, type RefObject } from "react";

import { configDownloadURL } from "@/features/config/api";

import { backupDownloadURL, isBackupFile, useRestoreBackup, type BackupExclusion } from "../api";

interface BackupDialogProps {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// Taking a copy and putting one back, from the page an operator is already on
// when they decide to. Both are worth saying plainly: an export carries every
// credential the panel holds, and a restore replaces the operator accounts along
// with everything else.
export const BackupDialog = ({ onClose, returnFocusRef }: BackupDialogProps) => {
    const statsId = useId();
    const changesId = useId();
    const fileRef = useRef<HTMLInputElement>(null);

    // History rather than configuration, and the bulk of a long-running panel's
    // file, so they start out left behind and are asked for rather than opted
    // out of.
    const [exclude, setExclude] = useState<BackupExclusion[]>(["stats", "changes"]);
    const [unreadable, setUnreadable] = useState<string | null>(null);
    const [restored, setRestored] = useState(false);
    const { trigger, isMutating, error } = useRestoreBackup();

    const toggle = (value: BackupExclusion, on: boolean) => {
        setExclude((carried) =>
            on ? [...carried, value] : carried.filter((entry) => entry !== value),
        );
    };

    const onFile = async (file: File | undefined) => {
        if (!file) {
            return;
        }

        setUnreadable(null);
        setRestored(false);

        // Read here rather than sent and refused: the endpoint replaces every
        // table, and it should not be reached by a file that was never a backup.
        if (!(await isBackupFile(file))) {
            setUnreadable("That file is not a backup this panel can read.");
            return;
        }

        if (await trigger(file)) {
            setRestored(true);
        }
    };

    return (
        <Dialog
            title="Backup & restore"
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width={500}
        >
            <Stack gap="normal">
                <Stack direction="horizontal" gap="spacious" wrap="wrap">
                    <FormControl id={statsId}>
                        <FormControl.Label>Leave out traffic history</FormControl.Label>
                        <Checkbox
                            id={statsId}
                            checked={exclude.includes("stats")}
                            onChange={(event) => toggle("stats", event.target.checked)}
                        />
                    </FormControl>

                    <FormControl id={changesId}>
                        <FormControl.Label>Leave out the change log</FormControl.Label>
                        <Checkbox
                            id={changesId}
                            checked={exclude.includes("changes")}
                            onChange={(event) => toggle("changes", event.target.checked)}
                        />
                    </FormControl>
                </Stack>

                <Stack direction="horizontal" gap="normal" wrap="wrap" justify="space-between">
                    {/* A link rather than a fetch, because the browser is what
                        should save it and the session is a cookie the request
                        carries on its own. */}
                    <Button as="a" href={backupDownloadURL(exclude)} download variant="primary">
                        Download a backup
                    </Button>

                    <Button
                        type="button"
                        variant="primary"
                        loading={isMutating}
                        onClick={() => fileRef.current?.click()}
                    >
                        Restore from a file
                    </Button>

                    {/* The button above stands in for this, because a bare file
                        input is the one control that never matches anything else
                        on the page. */}
                    <input
                        ref={fileRef}
                        type="file"
                        accept="application/json,.json"
                        hidden
                        onChange={(event) => {
                            void onFile(event.target.files?.[0]);
                            // Cleared so choosing the same file twice is still a
                            // change the input reports.
                            event.target.value = "";
                        }}
                    />
                </Stack>

                {/* Not a backup: what the nodes are being told to run, which is
                    read when a node is disagreeing with the panel about it. */}
                <Stack direction="horizontal" gap="normal" wrap="wrap">
                    <Button as="a" href={configDownloadURL()} download variant="primary">
                        Download the generated configuration
                    </Button>
                </Stack>

                <InlineMessage variant="warning">
                    A restore replaces the data in one transaction, operator accounts included. You
                    will be signing in next with the backup's credentials rather than your own.
                </InlineMessage>

                {unreadable && <InlineMessage variant="critical">{unreadable}</InlineMessage>}
                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
                {restored && (
                    <InlineMessage variant="success">
                        Restored. Sign in again to carry on.
                    </InlineMessage>
                )}
            </Stack>
        </Dialog>
    );
};
