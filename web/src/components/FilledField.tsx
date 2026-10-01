import {
    ActionList,
    ActionMenu,
    Checkbox,
    FormControl,
    IconButton,
    NativeSelect,
    Switch,
    Textarea,
    TextInput,
    Token,
} from "@gamecrafters/base-ui/react";
import { ChevronDownRegular, DismissCircleRegular } from "@gamecrafters/base-ui-icons";
import { useId, useState, type ComponentProps, type ReactNode } from "react";

import { useMenuInDialog } from "@/lib/menu";

// The fields a page sets its options with, drawn the reference's way rather than
// the form's: a raised box a little lighter than the page, with what the field is
// called written small inside its top edge and the value under it. The pages that
// hold a node's settings are rows of these, so the pieces are written once here.
//
// The label floats inside the box rather than standing above it, which is what
// keeps a row of them the height the reference's is. The classes are written out
// whole rather than assembled, since only what is written out is generated.

// Drawn into the top edge of the box. It is laid over the field rather than
// beside it, so it is passed over by the pointer and the field under it is what
// a press lands on.
const FLOATING_LABEL =
    "pointer-events-none absolute start-4 top-[7px] z-[1] text-[12px] leading-[18px] font-normal tracking-[0.1125px] text-[var(--foreground-color-muted)]";

// The box itself: as tall as the reference's, filled rather than outlined, and
// with none of the room a label standing above it would have left. Its fill is
// the page's own in the light scheme, so the shadow is what draws its edge
// there, and the smaller one is too faint to.
const FILLED_BOX =
    "mt-0 h-14 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] shadow-[var(--shadow-resting-medium)]";

interface FilledProps {
    id: string;
    label: string;
    // Sizes the field where it stands, which is the row's business.
    className?: string;
}

// The reference's line of small text under a field for what is wrong with it.
// It is the form control's own validation message, so the field is described by
// it and marked invalid, and it is drawn without the design system's icon. Each
// field writes it straight into its form control rather than through a
// component of its own, because the form control only finds it standing there.
const VALIDATION =
    "mt-0 min-h-[22px] items-end px-4 pb-0.5 text-[12px] leading-3 font-normal tracking-[0.4px] [&>[data-component='FormControl.Validation.Icon']]:hidden";

type FilledSelectProps = FilledProps &
    Omit<ComponentProps<typeof NativeSelect>, "id" | "size" | "block" | "className"> & {
        // What is wrong with the choice, said under the field as a text field
        // says it.
        validation?: string;
    };

// A choice from a list. The list always has something chosen -- a page offers
// the core's own default as an option by name -- so the label always sits in
// the top edge, as the reference's does once a value is set.
export const FilledSelect = ({
    id,
    label,
    className,
    validation,
    ...select
}: FilledSelectProps) => {
    return (
        <FormControl id={id} className={`group/field relative ${className ?? ""}`}>
            <FormControl.Label
                className={`${FLOATING_LABEL} group-has-[select[aria-invalid=true]]/field:text-[var(--foreground-color-danger)]`}
            >
                {label}
            </FormControl.Label>
            <NativeSelect
                id={id}
                block
                className={`${FILLED_BOX} [&>select]:m-0 [&>select]:h-full [&>select]:ps-4 [&>select]:pe-10 [&>select]:pt-6 [&>select]:pb-1 [&>select]:text-[16px] [&>select]:leading-6 [&>select]:tracking-[0.15px] [&>svg]:right-4`}
                {...select}
            />
            {validation && (
                <FormControl.Validation variant="error" className={VALIDATION}>
                    {validation}
                </FormControl.Validation>
            )}
        </FormControl>
    );
};

type FilledTextInputProps = FilledProps &
    Omit<
        ComponentProps<typeof TextInput>,
        "id" | "size" | "block" | "className" | "placeholder"
    > & {
        // Keeps the reference's line under the box for what is wrong with the
        // field, whether or not anything is, so nothing under it moves when
        // something is. Fields that are never wrong leave it out, as the
        // reference's rows of settings do.
        details?: boolean;
        // What is wrong with what was typed, said on that line; the label turns
        // the same colour, as the reference's does.
        validation?: string;
    };

// Something typed. Left empty, the label sits in the middle of the box the way a
// placeholder would, and moves up out of the way as soon as the field is entered
// or holds anything -- which the input says by whether its placeholder, a single
// space nobody sees, is showing.
//
// The group is named so that it is the field's own input that is asked about:
// a field can sit inside something that is a group of its own, and an empty
// field beside it would otherwise pull this one's label down over its value.
//
// What is wrong is the form control's own validation message, so the input is
// described by it and marked invalid, drawn as the reference's line of small
// text rather than with the icon.
export const FilledTextInput = ({
    id,
    label,
    className,
    details = false,
    validation,
    ...input
}: FilledTextInputProps) => {
    return (
        <FormControl
            id={id}
            className={`group/field relative ${details && !validation ? "pb-[22px]" : ""} ${className ?? ""}`}
        >
            <FormControl.Label
                className={`${FLOATING_LABEL} transition-[top,font-size,line-height,letter-spacing] duration-150 group-has-[input:placeholder-shown:not(:focus)]/field:top-4 group-has-[input:placeholder-shown:not(:focus)]/field:text-[16px] group-has-[input:placeholder-shown:not(:focus)]/field:leading-6 group-has-[input:placeholder-shown:not(:focus)]/field:tracking-[0.15px] group-has-[input[aria-invalid=true]]/field:text-[var(--foreground-color-danger)]`}
            >
                {label}
            </FormControl.Label>
            <TextInput
                id={id}
                block
                placeholder=" "
                className={`${FILLED_BOX} [&>input]:h-full [&>input]:ps-4 [&>input]:pe-1.5 [&>input]:pt-6 [&>input]:pb-1 [&>input]:text-[16px] [&>input]:leading-6 [&>input]:tracking-[0.15px]`}
                {...input}
            />
            {validation && (
                <FormControl.Validation variant="error" className={VALIDATION}>
                    {validation}
                </FormControl.Validation>
            )}
        </FormControl>
    );
};

type FilledTextareaProps = FilledProps &
    Omit<ComponentProps<typeof Textarea>, "id" | "block" | "className" | "placeholder"> & {
        // What is wrong with what was typed, said under the field as a text
        // field says it.
        validation?: string;
    };

// A document typed out, drawn as the reference draws a text area: the box with
// its label small in the top edge and the text under it, the label resting in
// the middle of the first line while there is nothing typed, as a text field's
// does. The text is set the way code is, since a document is what it holds.
export const FilledTextarea = ({
    id,
    label,
    className,
    validation,
    ...textarea
}: FilledTextareaProps) => {
    return (
        <FormControl id={id} className={`group/field relative ${className ?? ""}`}>
            <FormControl.Label
                className={`${FLOATING_LABEL} transition-[top,font-size,line-height,letter-spacing] duration-150 group-has-[textarea:placeholder-shown:not(:focus)]/field:top-4 group-has-[textarea:placeholder-shown:not(:focus)]/field:text-[16px] group-has-[textarea:placeholder-shown:not(:focus)]/field:leading-6 group-has-[textarea:placeholder-shown:not(:focus)]/field:tracking-[0.15px] group-has-[textarea[aria-invalid=true]]/field:text-[var(--foreground-color-danger)]`}
            >
                {label}
            </FormControl.Label>
            <Textarea
                id={id}
                block
                placeholder=" "
                validationStatus={validation ? "error" : undefined}
                className="mt-0 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] shadow-[var(--shadow-resting-medium)] [&>textarea]:ps-4 [&>textarea]:pe-4 [&>textarea]:pt-6 [&>textarea]:pb-2 [&>textarea]:font-mono [&>textarea]:text-[14px] [&>textarea]:leading-5"
                {...textarea}
            />
            {validation && (
                <FormControl.Validation variant="error" className={VALIDATION}>
                    {validation}
                </FormControl.Validation>
            )}
        </FormControl>
    );
};

type FilledListFieldProps = FilledProps & {
    // A line to an entry, in a box a few lines tall, or a comma to one, on one
    // line.
    separator: "\n" | ",";
    value: unknown;
    disabled?: boolean;
    validation?: string;
    onChange: (entries: string[]) => void;
};

// A list typed out, with the blanks left out of what it reads as. The text is
// the field's own while it is typed, so a line or a comma just typed stays until
// the entry after it does, and the list is what is handed back; a field keyed by
// what it lists starts afresh when that changes.
export const FilledListField = ({
    id,
    label,
    className,
    separator,
    value,
    disabled,
    validation,
    onChange,
}: FilledListFieldProps) => {
    const [text, setText] = useState(() =>
        Array.isArray(value) ? value.map(String).join(separator) : "",
    );

    const change = (next: string) => {
        setText(next);
        onChange(
            next
                .split(separator)
                .map((entry) => entry.trim())
                .filter(Boolean),
        );
    };

    return separator === "\n" ? (
        <FilledTextarea
            id={id}
            label={label}
            className={className}
            rows={5}
            spellCheck={false}
            disabled={disabled}
            validation={validation}
            value={text}
            onChange={(event) => change(event.target.value)}
        />
    ) : (
        <FilledTextInput
            id={id}
            label={label}
            className={className}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            validation={validation}
            value={text}
            onChange={(event) => change(event.target.value)}
        />
    );
};

type FilledMultiSelectProps = FilledProps & {
    // What can be chosen, by the value it is held as and what it is called.
    options: { value: string; label: string }[];
    value: string[];
    onChange: (value: string[]) => void;
    // What acts on the choice as a whole, standing outside the box after it.
    append?: ReactNode;
};

// Several things chosen from a list, drawn as the reference draws a select that
// takes more than one: the box with what is chosen written into it as chips
// under the label, a mark that clears them, the arrow of a list, and whatever
// else acts on the choice standing outside the box after it. Nothing chosen,
// the label sits in the middle of the box as an empty text field's does.
//
// The list is a menu of ticked items that stays open while they are ticked, as
// the reference's does, and puts itself away on Escape without the dialog it
// stands in. The chips are the box's content rather than controls of their own,
// so the button that opens the list is read out with them after its label.
export const FilledMultiSelect = ({
    id,
    label,
    className,
    options,
    value,
    onChange,
    append,
}: FilledMultiSelectProps) => {
    const labelId = useId();
    const chosenId = useId();
    const { anchorRef, isOpen, setIsOpen, onKeyDown } = useMenuInDialog();

    const chosen = options.filter((option) => value.includes(option.value));
    const toggle = (option: string) =>
        onChange(
            value.includes(option) ? value.filter((other) => other !== option) : [...value, option],
        );

    return (
        <div className={`flex items-center gap-4 ${className ?? ""}`}>
            <div
                data-empty={chosen.length ? undefined : ""}
                className="group/field relative min-w-0 flex-1"
                onKeyDown={onKeyDown}
            >
                <span
                    id={labelId}
                    className={`${FLOATING_LABEL} group-data-empty/field:top-4 group-data-empty/field:text-[16px] group-data-empty/field:leading-6 group-data-empty/field:tracking-[0.15px]`}
                >
                    {label}
                </span>

                <ActionMenu open={isOpen} onOpenChange={setIsOpen} anchorRef={anchorRef}>
                    <ActionMenu.Anchor>
                        <button
                            type="button"
                            id={id}
                            aria-labelledby={`${labelId} ${chosenId}`}
                            className="mt-0 flex min-h-14 w-full cursor-pointer items-end rounded-[4px] border-0 bg-[var(--control-background-color-rest)] ps-4 pe-[72px] pt-[26px] pb-1.5 text-start shadow-[var(--shadow-resting-medium)]"
                        >
                            <span id={chosenId} className="flex min-w-0 flex-wrap gap-1">
                                {chosen.map((option) => (
                                    <Token
                                        key={option.value}
                                        text={option.label}
                                        size="large"
                                        className="h-6 rounded-full border-0 bg-[var(--control-background-color-active)] px-2.5 text-[12px] leading-[18px] font-normal tracking-[0.15px] text-[var(--foreground-color-default)]"
                                    />
                                ))}
                            </span>
                        </button>
                    </ActionMenu.Anchor>

                    <ActionMenu.Overlay align="start" width="medium">
                        <ActionList selectionVariant="multiple">
                            {options.map((option) => (
                                <ActionList.Item
                                    key={option.value}
                                    selected={value.includes(option.value)}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        toggle(option.value);
                                    }}
                                >
                                    {option.label}
                                </ActionList.Item>
                            ))}
                        </ActionList>
                    </ActionMenu.Overlay>
                </ActionMenu>

                {/* Laid over the box rather than inside the button that opens the
                    list, which would be one control inside another, and shown
                    while the pointer or the focus is on the field, as the
                    reference's is. */}
                {chosen.length > 0 && (
                    <IconButton
                        icon={<DismissCircleRegular size={20} />}
                        aria-label={`Clear ${label}`}
                        variant="invisible"
                        className="absolute end-11 top-1/2 size-6 min-w-0 -translate-y-1/2 rounded-full p-0 text-[var(--foreground-color-muted)] opacity-0 transition-opacity group-focus-within/field:opacity-100 group-hover/field:opacity-100"
                        onClick={() => onChange([])}
                    />
                )}
                <ChevronDownRegular
                    aria-hidden
                    size={16}
                    className="pointer-events-none absolute end-[18px] top-1/2 -translate-y-1/2 text-[var(--foreground-color-muted)]"
                />
            </div>

            {append}
        </div>
    );
};

type FilledSwitchProps = Omit<FilledProps, "id"> & {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
};

// A setting that is on or off and takes effect as a whole, drawn where the
// reference draws a switch rather than a box: a field's width and height, with
// the switch in a round target a little in from its edge and the label straight
// after it -- without the gap the design system leaves between the two, which
// the label's own padding stands in for.
export const FilledSwitch = ({
    label,
    className,
    checked,
    disabled,
    onCheckedChange,
}: FilledSwitchProps) => {
    return (
        <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            className={`flex h-14 items-center gap-0 ps-[9.6px] ${className ?? ""}`}
        >
            <span className="grid size-10 shrink-0 place-items-center">
                <Switch.Control>
                    <Switch.Thumb />
                </Switch.Control>
            </span>
            <Switch.Label className="ps-2.5 text-[16px] leading-6 font-normal tracking-[0.15px]">
                {label}
            </Switch.Label>
            <Switch.HiddenInput />
        </Switch>
    );
};

type FilledCheckboxProps = FilledProps & Omit<ComponentProps<typeof Checkbox>, "id" | "className">;

// A setting that is on or off: a box the size of the reference's in the middle
// of a target as wide as the row is tall, and the label beside it at the size of
// a field's value rather than of its label, since here it is both.
export const FilledCheckbox = ({ id, label, className, ...checkbox }: FilledCheckboxProps) => {
    return (
        <FormControl id={id} className={`h-14 items-center ${className ?? ""}`}>
            <FormControl.Label className="ps-0 text-[16px] leading-6 font-normal tracking-[0.15px]">
                {label}
            </FormControl.Label>
            <Checkbox
                id={id}
                className="m-[11px] size-[18px] rounded-[2px] border-2 not-checked:border-[var(--foreground-color-muted)]"
                {...checkbox}
            />
        </FormControl>
    );
};
