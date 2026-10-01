import { NativeSelect, Text } from "@gamecrafters/base-ui/react";
import { useId } from "react";
import {
    Controller,
    useWatch,
    type Control,
    type FieldErrors,
    type UseFormRegister,
    type UseFormSetValue,
} from "react-hook-form";

import { DialSection } from "@/components/DialSection";
import { FilledSelect, FilledTextInput } from "@/components/FilledField";
import { FormSection } from "@/components/FormSection";

import {
    dials,
    OUTBOUND_TYPES,
    optionsDocument,
    optionsForType,
    parseOptions,
    refusesAll,
    sendsToServer,
    serverOf,
    WIREGUARD,
    withServerOption,
    type OutboundRequest,
} from "../api";
import { outboundCreateIssue } from "../api/field-specs";

import { OutboundTypeFields } from "./OutboundTypeFields";
import { WireGuardFields } from "./WireGuardFields";

interface OutboundFieldsProps {
    register: UseFormRegister<OutboundRequest>;
    control: Control<OutboundRequest>;
    errors: FieldErrors<OutboundRequest>;
    setValue: UseFormSetValue<OutboundRequest>;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// Writing a route out and amending one ask for the same things, so the fields
// are written once here rather than twice with small differences that turn into
// large ones. They are laid out as the reference lays them out: the type and
// the tag, where a type that sends to a server sends, then the type's own
// options and how it dials, each in a block of its own.
//
// Both dialogs present the selected type's fields directly. Existing records
// keep options this panel does not model in the form's document, even though
// that document is no longer shown.
export const OutboundFields = ({ register, control, errors, setValue }: OutboundFieldsProps) => {
    const typeId = useId();
    const tagId = useId();
    const serverId = useId();
    const serverPortId = useId();
    const [type, tag, document] = useWatch({ control, name: ["type", "tag", "options"] });
    const parsed = parseOptions(document);
    const options = parsed ?? {};
    // Fields are read off the stored options document. It is kept as form state
    // so edits to one field do not discard options the panel does not display.
    const isUnreadable = parsed === null;
    const fieldIssue = errors.options && parsed ? outboundCreateIssue(type, parsed) : null;

    const setOptions = (next: Record<string, unknown>) =>
        setValue("options", optionsDocument(next), { shouldDirty: true, shouldValidate: true });
    const setServerOption = (field: "server" | "port", value: unknown) =>
        setOptions(withServerOption(type, options, field, value));
    const { server, port } = serverOf(type, options);
    const tagField = (
        <FilledTextInput
            id={tagId}
            label="Tag"
            className={FIELD}
            autoComplete="off"
            spellCheck={false}
            validation={errors.tag?.message}
            {...register("tag")}
        />
    );

    return (
        <>
            {/* Rows eight pixels apart, and the blocks straight after them. */}
            <div className="flex flex-col gap-2">
                <div className={ROW}>
                    {/* Chosen rather than typed: "vmesss" is a route the core
                        refuses at startup, and a free-text field is how an
                        operator finds that out from a node that stopped rather
                        than from the form. */}
                    <Controller
                        control={control}
                        name="type"
                        render={({ field }) => (
                            <FilledSelect
                                id={typeId}
                                label="Type"
                                className={FIELD}
                                validation={errors.type?.message}
                                ref={field.ref}
                                value={field.value}
                                onChange={(event) => {
                                    const next = event.target.value;

                                    field.onChange(next);
                                    // Another type starts afresh, as the
                                    // reference starts it, and keeps only what
                                    // it shares with the one before.
                                    setOptions(optionsForType(options, next, field.value));
                                }}
                            >
                                {/* Nothing preselected on a new route: where
                                    traffic goes is what an outbound is, and
                                    defaulting it would have an operator accept a
                                    choice they never made. */}
                                {!field.value && (
                                    <NativeSelect.Option value="">
                                        Choose a type
                                    </NativeSelect.Option>
                                )}

                                {OUTBOUND_TYPES.map((outboundType) => (
                                    <NativeSelect.Option key={outboundType} value={outboundType}>
                                        {outboundType === WIREGUARD ? "WireGuard" : outboundType}
                                    </NativeSelect.Option>
                                ))}

                                {/* Types from newer core releases keep their type
                                    while edited. */}
                                {field.value && !OUTBOUND_TYPES.includes(field.value) && (
                                    <NativeSelect.Option value={field.value}>
                                        {field.value} — not one this panel knows
                                    </NativeSelect.Option>
                                )}
                            </FilledSelect>
                        )}
                    />

                    {tagField}
                </div>

                {/* A block route has nothing to set past these two, so what it
                    does is said under them rather than left to be guessed from
                    a dialog with nothing else in it. */}
                {refusesAll(type) && (
                    <Text as="p" className="m-0 text-[12px] text-[var(--foreground-color-muted)]">
                        Every connection sent here is refused, and there is nothing else to set. A
                        rule refuses what it matches without one, with the reject action; a block
                        route is for where only a route out can be named, such as the default
                        outbound.
                    </Text>
                )}

                {/* Options the core accepts rather than fields of the record, so
                    they are read off the document and written back into it --
                    a WireGuard route's into its peer, the far end of the
                    tunnel. */}
                {sendsToServer(type) && (
                    <div className={ROW}>
                        <FilledTextInput
                            id={serverId}
                            label="Server address"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={isUnreadable}
                            validation={
                                fieldIssue?.path === "server" ? fieldIssue.message : undefined
                            }
                            value={server ?? ""}
                            onChange={(event) => setServerOption("server", event.target.value)}
                        />
                        {/* Cleared, the port leaves the document rather than
                            being written as nothing. */}
                        <FilledTextInput
                            id={serverPortId}
                            label="Server port"
                            className={FIELD}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={65535}
                            disabled={isUnreadable}
                            validation={
                                fieldIssue?.path === "server_port" ? fieldIssue.message : undefined
                            }
                            value={port === null ? "" : String(port)}
                            onChange={(event) =>
                                setServerOption(
                                    "port",
                                    event.target.value === ""
                                        ? undefined
                                        : Number(event.target.value),
                                )
                            }
                        />
                    </div>
                )}
            </div>

            {type === WIREGUARD ? (
                <FormSection title="WireGuard">
                    <WireGuardFields
                        options={options}
                        disabled={isUnreadable}
                        onChange={setOptions}
                        issue={fieldIssue}
                    />
                </FormSection>
            ) : (
                <OutboundTypeFields
                    type={type}
                    options={options}
                    onChange={setOptions}
                    disabled={isUnreadable}
                    issue={fieldIssue}
                />
            )}

            {dials(type) && (
                <DialSection
                    options={options}
                    tag={tag}
                    disabled={isUnreadable}
                    onChange={setOptions}
                />
            )}
        </>
    );
};
