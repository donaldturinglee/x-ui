import {
    AnchoredOverlay,
    Button,
    FormControl,
    IconButton,
    NativeSelect,
    Stack,
    TextInput,
} from "@gamecrafters/base-ui/react";
import { FilterRegular } from "@gamecrafters/base-ui-icons";
import { useId, useState } from "react";

import { emptyFilter, useClientGroups, type ClientFilter } from "../api";

interface FilterMenuProps {
    filter: ClientFilter;
    onApply: (filter: ClientFilter) => void;
}

// A filter that is on is a listing that is short of subscribers, so the button
// says so in a colour of its own while one is.
const isFiltering = (filter: ClientFilter) =>
    Boolean(filter.group || filter.search || filter.enabled !== undefined);

// What narrows the listing, behind the one button beside Add that opens it. It is
// filled in and then applied rather than applied as it is typed, the way the
// reference does it: the API does the narrowing, and a request per keystroke
// would be the panel asking about half-typed names.
export const FilterMenu = ({ filter, onApply }: FilterMenuProps) => {
    const statusId = useId();
    const groupId = useId();
    const nameId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const [draft, setDraft] = useState(filter);
    const { data: groups } = useClientGroups();

    // Narrowing the listing puts it back on its first page. Keeping the offset
    // would answer a new search from partway down it, which reads as a search
    // that found nothing.
    const apply = (next: ClientFilter) => {
        onApply({ ...next, offset: 0 });
        setIsOpen(false);
    };

    return (
        <AnchoredOverlay
            open={isOpen}
            // Opened on what is applied rather than on whatever was typed last
            // and never applied, so it always starts from the listing on screen.
            onOpen={() => {
                setDraft(filter);
                setIsOpen(true);
            }}
            onClose={() => setIsOpen(false)}
            side="outside-bottom"
            align="center"
            // Keyed because the overlay puts the anchor in a list beside itself,
            // and React asks for a key on anything handed to it that way.
            renderAnchor={(anchorProps) => (
                <IconButton
                    key="anchor"
                    {...anchorProps}
                    icon={<FilterRegular size={24} />}
                    aria-label="Filter subscribers"
                    variant="invisible"
                    className={`size-12 rounded-full ${
                        isFiltering(filter)
                            ? "text-[var(--foreground-color-accent)]"
                            : "text-[var(--foreground-color-default)]"
                    }`}
                />
            )}
        >
            <Stack
                as="form"
                gap="none"
                className="w-44"
                onSubmit={(event) => {
                    event.preventDefault();
                    apply(draft);
                }}
            >
                <Stack gap="condensed" className="p-4">
                    <FormControl id={statusId}>
                        <FormControl.Label>Status</FormControl.Label>
                        <NativeSelect
                            id={statusId}
                            block
                            value={draft.enabled === undefined ? "" : String(draft.enabled)}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    enabled:
                                        event.target.value === ""
                                            ? undefined
                                            : event.target.value === "true",
                                })
                            }
                        >
                            <NativeSelect.Option value="">None</NativeSelect.Option>
                            <NativeSelect.Option value="true">Enabled</NativeSelect.Option>
                            <NativeSelect.Option value="false">Disabled</NativeSelect.Option>
                        </NativeSelect>
                    </FormControl>

                    <FormControl id={groupId}>
                        <FormControl.Label>Group</FormControl.Label>
                        <NativeSelect
                            id={groupId}
                            block
                            value={draft.group}
                            onChange={(event) => setDraft({ ...draft, group: event.target.value })}
                        >
                            <NativeSelect.Option value="">All</NativeSelect.Option>
                            {groups?.map((group) => (
                                <NativeSelect.Option key={group} value={group}>
                                    {group}
                                </NativeSelect.Option>
                            ))}
                        </NativeSelect>
                    </FormControl>

                    <FormControl id={nameId}>
                        <FormControl.Label>Name</FormControl.Label>
                        <TextInput
                            id={nameId}
                            block
                            type="search"
                            autoComplete="off"
                            value={draft.search}
                            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                        />
                    </FormControl>
                </Stack>

                <Stack direction="horizontal" gap="condensed" justify="end" className="p-2">
                    <Button onClick={() => apply(emptyFilter)}>Clear</Button>
                    <Button type="submit" variant="primary">
                        Apply
                    </Button>
                </Stack>
            </Stack>
        </AnchoredOverlay>
    );
};
