import { NativeSelect } from "@gamecrafters/base-ui/react";
import { useId } from "react";
import {
    Controller,
    useWatch,
    type Control,
    type FieldErrors,
    type UseFormRegister,
    type UseFormSetValue,
} from "react-hook-form";

import { FilledSelect, FilledTextInput } from "@/components/FilledField";
import { ListenSection } from "@/components/ListenSection";

import {
    carriesTls,
    INBOUND_TYPES,
    listensOn,
    optionsDocument,
    parseOptions,
    supportsSharing,
    withoutListenOptions,
    type InboundRequest,
} from "../api";
import { withSecurity } from "../api/tls";

import { TlsFields } from "./TlsFields";

interface InboundFieldsProps {
    register: UseFormRegister<InboundRequest>;
    control: Control<InboundRequest>;
    errors: FieldErrors<InboundRequest>;
    setValue: UseFormSetValue<InboundRequest>;
    // Only a new listener restores this address after switching back from a
    // type that has no listen address. Edits keep the stored value.
    newListenDefault?: string;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// Writing a listener and amending one ask for the same things, so the fields are
// written once here rather than twice with small differences that turn into
// large ones. They are laid out as the reference lays them out: the type and
// the tag, then where the listener binds and, for a type that can be served
// over TLS, how it is served and with what, each in a block of its own.
//
// The reference also edits each type's own options, its users and the rest of
// what a client is handed; the panel carries all of that through untouched
// instead.
// The core accepts a different set of options for every listener type and
// gains more with each of its releases, so they ride along in `options`, the
// document the form holds, and only the listen options every type shares and
// the TLS are edited in it -- see `toOptionsDocument` for why dropping the rest
// would be data loss.
export const InboundFields = ({
    register,
    control,
    errors,
    setValue,
    newListenDefault,
}: InboundFieldsProps) => {
    const typeId = useId();
    const tagId = useId();
    const listenId = useId();
    const listenPortId = useId();
    const shareAddressId = useId();

    const [type, tag, document] = useWatch({ control, name: ["type", "tag", "options"] });
    const options = parseOptions(document) ?? {};

    const setOptions = (next: Record<string, unknown>) =>
        setValue("options", optionsDocument(next), { shouldDirty: true });

    return (
        <>
            <div className={ROW}>
                {/* Chosen rather than typed: "vmesss" is a listener the core
                    refuses at startup, and a free-text field is how an operator
                    finds that out from a node that stopped rather than from the
                    form. */}
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
                                const wasListenless = !listensOn(field.value);
                                let kept = options;

                                field.onChange(next);

                                // A type that binds nothing, or that nothing is
                                // served over TLS for, keeps none of what it
                                // would bind or be served with, as the core
                                // refuses those keys on it.
                                if (!listensOn(next)) {
                                    setValue("listen", "");
                                    setValue("listen_port", 0);
                                    kept = withoutListenOptions(kept);
                                } else if (wasListenless && newListenDefault) {
                                    setValue("listen", newListenDefault);
                                }

                                if (!carriesTls(next)) {
                                    setValue("security", "none");
                                    kept = withSecurity(kept, "none");
                                }

                                if (kept !== options) {
                                    setOptions(kept);
                                }
                            }}
                        >
                            {/* Nothing preselected on a new listener: which type
                                to serve is what a listener is, and defaulting it
                                would have an operator accept a choice they never
                                made. */}
                            {!field.value && (
                                <NativeSelect.Option value="">Choose a type</NativeSelect.Option>
                            )}

                            {INBOUND_TYPES.map((inboundType) => (
                                <NativeSelect.Option key={inboundType} value={inboundType}>
                                    {inboundType}
                                </NativeSelect.Option>
                            ))}

                            {/* A type from a newer core release than this panel
                                knows. Kept so an edit made for some other reason
                                does not quietly rewrite it to whichever is
                                first. */}
                            {field.value && !INBOUND_TYPES.includes(field.value) && (
                                <NativeSelect.Option value={field.value}>
                                    {field.value} — not one this panel knows
                                </NativeSelect.Option>
                            )}
                        </FilledSelect>
                    )}
                />

                <FilledTextInput
                    id={tagId}
                    label="Tag"
                    className={FIELD}
                    autoComplete="off"
                    spellCheck={false}
                    validation={errors.tag?.message}
                    {...register("tag")}
                />
            </div>

            {/* Ten pixels below the type, as the reference's blocks stand. */}
            {(listensOn(type) || carriesTls(type)) && (
                <div className="mt-2.5">
                    {listensOn(type) && (
                        <ListenSection
                            tag={tag}
                            options={options}
                            onChange={setOptions}
                            address={
                                <div className={ROW}>
                                    {/* A new listener starts at ::. Existing
                                        empty addresses remain valid when edited. */}
                                    <FilledTextInput
                                        id={listenId}
                                        label="Address"
                                        className={FIELD}
                                        autoComplete="off"
                                        spellCheck={false}
                                        validation={errors.listen?.message}
                                        {...register("listen")}
                                    />
                                    {/* Zero is no port, which is where a cleared
                                        field lands rather than on a missing one. */}
                                    <Controller
                                        control={control}
                                        name="listen_port"
                                        render={({ field }) => (
                                            <FilledTextInput
                                                id={listenPortId}
                                                label="Port"
                                                className={FIELD}
                                                type="number"
                                                inputMode="numeric"
                                                min={1}
                                                max={65535}
                                                validation={errors.listen_port?.message}
                                                ref={field.ref}
                                                value={field.value ? String(field.value) : ""}
                                                onChange={(event) =>
                                                    field.onChange(Number(event.target.value) || 0)
                                                }
                                                onBlur={field.onBlur}
                                            />
                                        )}
                                    />
                                    {supportsSharing(type) && (
                                        <FilledTextInput
                                            id={shareAddressId}
                                            label="Share address"
                                            className={FIELD}
                                            autoComplete="off"
                                            autoCapitalize="none"
                                            spellCheck={false}
                                            validation={errors.share_address?.message}
                                            {...register("share_address")}
                                        />
                                    )}
                                </div>
                            }
                        />
                    )}

                    {carriesTls(type) && (
                        <TlsFields
                            control={control}
                            errors={errors}
                            options={options}
                            onChange={setOptions}
                        />
                    )}
                </div>
            )}
        </>
    );
};
