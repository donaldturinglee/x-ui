import { useState, type ComponentProps } from "react";

import { FilledTextInput } from "@/components/FilledField";

import { fromList, toList } from "../api/experimental";

type ListFieldProps = Omit<
    ComponentProps<typeof FilledTextInput>,
    "value" | "onChange" | "list"
> & {
    // The list as the document holds it.
    items: unknown;
    onChange: (list: string[]) => void;
};

// A list typed as the reference asks for it, comma separated. What is typed is
// kept as it was typed rather than read back from the list it makes, which would
// swallow a comma the moment it went in; a list changed from elsewhere is shown
// as the list it now is.
export const ListField = ({ items, onChange, ...field }: ListFieldProps) => {
    const [text, setText] = useState(() => fromList(items));
    const held = Array.isArray(items) ? items.filter((item) => typeof item === "string") : [];
    const shown = JSON.stringify(toList(text)) === JSON.stringify(held) ? text : fromList(held);

    return (
        <FilledTextInput
            {...field}
            autoComplete="off"
            spellCheck={false}
            value={shown}
            onChange={(event) => {
                setText(event.target.value);
                onChange(toList(event.target.value));
            }}
        />
    );
};
