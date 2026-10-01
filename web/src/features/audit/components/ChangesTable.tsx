import {
    DataTable,
    EmptyState,
    InlineMessage,
    Label,
    RelativeTime,
    Table,
    Text,
    type Column,
    type LabelVariant,
} from "@gamecrafters/base-ui/react";
import { HistoryRegular } from "@gamecrafters/base-ui-icons";
import { useId } from "react";

import { describeSubject, isAutomated, useChanges, type Change } from "../api";

// The API is the authority on which actions exist, so anything it grows later
// still reads as a plain label rather than going untitled.
const ACTION_VARIANTS: Record<string, LabelVariant> = {
    new: "success",
    edit: "default",
    del: "danger",
    disable: "attention",
    reset: "secondary",
    start: "secondary",
    maintenance: "attention",
    resume: "success",
};

const toDate = (seconds: number) => new Date(seconds * 1000);

const columns: Column<Change>[] = [
    {
        header: "When",
        field: "dateTime",
        rowHeader: true,
        sortBy: "datetime",
        renderCell: (change) => <RelativeTime date={toDate(change.dateTime)} />,
    },
    {
        header: "Who",
        field: "actor",
        sortBy: "alphanumeric",
        // Telling a job apart from an operator is the difference between
        // "somebody did this" and "the quota ran out", which is usually the
        // question being asked of this log.
        renderCell: (change) => (
            <Text className={isAutomated(change) ? "opacity-70" : undefined}>{change.actor}</Text>
        ),
    },
    {
        header: "What",
        field: "key",
        sortBy: "alphanumeric",
    },
    {
        header: "Action",
        field: "action",
        sortBy: "alphanumeric",
        renderCell: (change) => (
            <Label variant={ACTION_VARIANTS[change.action] ?? "default"}>{change.action}</Label>
        ),
    },
    {
        id: "subject",
        header: "Subject",
        // The API stores just enough to identify the object rather than its
        // contents, which is deliberate: an audit log anyone can read should
        // not be where a subscriber's credentials end up.
        renderCell: (change) => <Text>{describeSubject(change)}</Text>,
    },
];

const columnKey = (column: Column<Change>) => column.id ?? column.field;

const gridTemplateColumns = `repeat(${columns.length}, minmax(max-content, 1fr))`;

interface ChangesTableProps {
    // Whose changes, or everybody's.
    actor?: string;
    // Whether the title is left to whatever the table sits in -- a dialog that
    // says the same thing in its own -- and kept only for what reads it out.
    hideTitle?: boolean;
}

export const ChangesTable = ({ actor, hideTitle }: ChangesTableProps) => {
    const titleId = useId();
    const { data: changes, error, isLoading } = useChanges(actor);

    return (
        <Table.Container>
            <Table.Title as="h2" id={titleId} className={hideTitle ? "sr-only" : undefined}>
                {actor ? `Changes by ${actor}` : "Recent changes"}
            </Table.Title>

            {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

            {isLoading && <Table.Skeleton columns={columns} rows={6} />}

            {changes &&
                (changes.length ? (
                    <DataTable
                        aria-labelledby={titleId}
                        data={changes}
                        columns={columns}
                        initialSortColumn="dateTime"
                        initialSortDirection="DESC"
                    />
                ) : (
                    <Table aria-labelledby={titleId} gridTemplateColumns={gridTemplateColumns}>
                        <Table.Head>
                            <Table.Row>
                                {columns.map((column) => (
                                    <Table.Header key={columnKey(column)}>
                                        {typeof column.header === "string"
                                            ? column.header
                                            : column.header()}
                                    </Table.Header>
                                ))}
                            </Table.Row>
                        </Table.Head>

                        <Table.Body>
                            <Table.Row>
                                <Table.Cell
                                    className="col-span-full justify-center"
                                    colSpan={columns.length}
                                >
                                    <EmptyState
                                        icon={HistoryRegular}
                                        title="Nothing has changed yet"
                                        description="Every change an operator or a background job makes is recorded here."
                                    />
                                </Table.Cell>
                            </Table.Row>
                        </Table.Body>
                    </Table>
                ))}
        </Table.Container>
    );
};
