import { Dialog, IconButton, InlineMessage, Stack, Table } from "@gamecrafters/base-ui/react";
import {
    ArrowSyncRegular,
    CloudArrowDownRegular,
    CloudArrowUpRegular,
    PeopleRegular,
    type IconProps,
} from "@gamecrafters/base-ui-icons";
import type { ComponentType, RefObject } from "react";

import { useSystemStatus } from "../api";

interface CountsDialogProps {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// What the panel holds, named the way the pages that hold it are named rather
// than the way the tables are.
const ROWS: { key: string; label: string; Icon: ComponentType<IconProps> }[] = [
    { key: "clients", label: "Clients", Icon: PeopleRegular },
    { key: "inbounds", label: "Inbounds", Icon: CloudArrowDownRegular },
    { key: "outbounds", label: "Outbounds", Icon: CloudArrowUpRegular },
];

// How much of everything there is. The figures are counted on the read rather
// than kept, which is why this is a dialog with a button to ask again rather
// than a tile that asks every few seconds.
export const CountsDialog = ({ onClose, returnFocusRef }: CountsDialogProps) => {
    const { data: status, isValidating, mutate } = useSystemStatus();

    const database = status?.database;

    return (
        <Dialog
            title="Counts"
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width={400}
            renderHeader={({ title, dialogLabelId, onClose: onHeaderClose }) => (
                <Dialog.Header>
                    <div className="flex items-center">
                        <Dialog.Title id={dialogLabelId} className="grow px-2 py-[6px]">
                            {title}
                        </Dialog.Title>

                        <IconButton
                            icon={<ArrowSyncRegular />}
                            aria-label="Count again"
                            variant="invisible"
                            loading={isValidating}
                            onClick={() => void mutate()}
                        />

                        <Dialog.CloseButton onClose={() => onHeaderClose("close-button")} />
                    </div>
                </Dialog.Header>
            )}
        >
            <Stack gap="normal">
                {database ? (
                    <Table
                        aria-label="Counts"
                        cellPadding="condensed"
                        gridTemplateColumns="max-content 1fr max-content"
                    >
                        <Table.Body>
                            {ROWS.map(({ key, label, Icon }) => (
                                <Table.Row key={key}>
                                    <Table.Cell>
                                        <Icon
                                            aria-hidden
                                            focusable={false}
                                            className="text-[var(--foreground-color-muted)]"
                                        />
                                    </Table.Cell>
                                    <Table.Cell scope="row">{label}</Table.Cell>
                                    <Table.Cell align="end">{database[key] ?? 0}</Table.Cell>
                                </Table.Row>
                            ))}
                        </Table.Body>
                    </Table>
                ) : (
                    <InlineMessage variant="warning">
                        The panel could not read its own tables. What it says everywhere else was
                        read before that happened.
                    </InlineMessage>
                )}
            </Stack>
        </Dialog>
    );
};
