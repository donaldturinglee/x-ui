import { NativeSelect } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { DialSection } from "@/components/DialSection";
import {
    FilledListField,
    FilledSelect,
    FilledSwitch,
    FilledTextarea,
    FilledTextInput,
} from "@/components/FilledField";
import { FormDialog } from "@/components/FormDialog";
import { FormSection } from "@/components/FormSection";

import {
    DNS_SERVER_DOCS,
    DNS_SERVER_TYPES,
    dnsServerDials,
    dnsServerOptionsForType,
    dnsServerRequest,
    fromDnsServer,
    hasOwnDnsOptions,
    hasPath,
    isAddressed,
    optionsDocument,
    parseDocument,
    toDnsServer,
    type DnsServer,
    type DnsServerRequest,
} from "../api";

import { PredefinedHosts } from "./PredefinedHosts";

interface DnsServerDialogProps {
    // The server being amended, or none for a new one.
    server?: DnsServer;
    // The tags the servers already have, which a new one may not take.
    takenTags: string[];
    onSave: (server: DnsServer) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up; a wide one two thirds from a tablet
// up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";
const HALF = "col-span-12 min-[600px]:col-span-6";
const WIDE = "col-span-12 min-[600px]:col-span-8";

// A server a node can ask, written into the page rather than to the API: DNS is a
// section of the base document, and the page's own Save is what writes that
// document back, the way the reference keeps its edits until Save is pressed.
//
// Laid out as the reference lays it out, set in from the dialog's edges as its
// is: the type and the tag, where a server asked over the network is asked, how
// it is dialled, and what each type asks for besides. What a server asked over
// TLS or HTTP is asked with is typed out as the document the server is stored
// as, where the reference has blocks of fields; the rest are fields over keys of
// that same document.
//
// The tag is set once, for the reason a route out's is: rules and the final
// server name it, and so may parts of the document this page never shows.
export const DnsServerDialog = ({
    server,
    takenTags,
    onSave,
    onClose,
    returnFocusRef,
}: DnsServerDialogProps) => {
    const formId = useId();
    const typeId = useId();
    const tagId = useId();
    const addressId = useId();
    const portId = useId();
    const pathId = useId();
    const hostsId = useId();
    const optionsId = useId();
    const interfaceId = useId();
    const inet4Id = useId();
    const inet6Id = useId();
    const {
        register,
        control,
        handleSubmit,
        setError,
        setValue,
        formState: { errors },
    } = useForm<DnsServerRequest>({
        resolver: zodResolver(dnsServerRequest),
        defaultValues: server ? fromDnsServer(server) : { type: "", tag: "", options: "" },
    });

    const [type, tag, document] = useWatch({ control, name: ["type", "tag", "options"] });
    const parsed = parseDocument(document);
    const options = parsed ?? {};
    // The fields are read off the document, so while it is not one they can be
    // read off they are held still, and the document is put right where it is
    // typed.
    const isUnreadable = parsed === null;

    const setOptions = (next: Record<string, unknown>) =>
        setValue("options", optionsDocument(next), { shouldDirty: true });
    const setOption = (key: string, value: unknown) => setOptions({ ...options, [key]: value });
    const text = (key: string) => (typeof options[key] === "string" ? options[key] : "");

    // Rules and the final server name a server by its tag, so two with one tag
    // would leave the core unable to tell which was meant. Caught here, since
    // there is no API between the form and the document to refuse it.
    const onSubmit = handleSubmit((values) => {
        if (!server && takenTags.includes(values.tag)) {
            setError("tag", { message: "Another server has this tag." });
            return;
        }

        onSave(toDnsServer(values));
    });

    return (
        <FormDialog
            title={server ? "Edit DNS server" : "Add DNS server"}
            docs={DNS_SERVER_DOCS}
            formId={formId}
            isSaving={false}
            isBodyPadded
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                {/* Rows eight pixels apart, and the blocks straight after them,
                    with a row after a block straight after it too. */}
                <div className="flex flex-col gap-2">
                    <div className={ROW}>
                        {/* Chosen rather than typed, as a listener's is: a
                            misspelled type is a node that will not start. One
                            from a newer core than this panel knows is kept on an
                            edit. */}
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
                                        // reference starts it, keeping only what
                                        // it shares with the one before.
                                        setOptions(dnsServerOptionsForType(options, next));
                                    }}
                                >
                                    {!field.value && (
                                        <NativeSelect.Option value="">
                                            Choose a type
                                        </NativeSelect.Option>
                                    )}
                                    {DNS_SERVER_TYPES.map((serverType) => (
                                        <NativeSelect.Option key={serverType} value={serverType}>
                                            {serverType}
                                        </NativeSelect.Option>
                                    ))}
                                    {field.value && !DNS_SERVER_TYPES.includes(field.value) && (
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
                            disabled={Boolean(server)}
                            validation={errors.tag?.message}
                            {...register("tag")}
                        />
                    </div>

                    {isAddressed(type) && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={addressId}
                                label="Address"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={isUnreadable}
                                value={text("server")}
                                onChange={(event) => setOption("server", event.target.value)}
                            />
                            {/* Cleared, the port leaves the document rather than
                                being written as nothing. */}
                            <FilledTextInput
                                id={portId}
                                label="Port"
                                className={FIELD}
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={65535}
                                disabled={isUnreadable}
                                value={
                                    typeof options.server_port === "number"
                                        ? String(options.server_port)
                                        : ""
                                }
                                onChange={(event) =>
                                    setOption(
                                        "server_port",
                                        event.target.value === ""
                                            ? undefined
                                            : Number(event.target.value),
                                    )
                                }
                            />
                        </div>
                    )}

                    {hasPath(type) && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={pathId}
                                label="Path"
                                className={WIDE}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={isUnreadable}
                                value={text("path")}
                                onChange={(event) =>
                                    setOption("path", event.target.value || undefined)
                                }
                            />
                        </div>
                    )}

                    {/* The files a hosts server reads, as a list. */}
                    {type === "hosts" && !isUnreadable && (
                        <div className={ROW}>
                            <FilledListField
                                id={hostsId}
                                label="Path (comma separated)"
                                className={HALF}
                                separator=","
                                value={options.path}
                                onChange={(paths) =>
                                    setOption("path", paths.length ? paths : undefined)
                                }
                            />
                        </div>
                    )}

                    {/* The types that dial nowhere have no block between their
                        own row and the ones above, so it stands with them. */}
                    {type === "fakeip" && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={inet4Id}
                                label="IPv4 range"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={isUnreadable}
                                value={text("inet4_range")}
                                onChange={(event) =>
                                    setOption("inet4_range", event.target.value || undefined)
                                }
                            />
                            <FilledTextInput
                                id={inet6Id}
                                label="IPv6 range"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={isUnreadable}
                                value={text("inet6_range")}
                                onChange={(event) =>
                                    setOption("inet6_range", event.target.value || undefined)
                                }
                            />
                        </div>
                    )}
                </div>

                {dnsServerDials(type) && (
                    <DialSection
                        options={options}
                        tag={tag}
                        disabled={isUnreadable}
                        onChange={setOptions}
                    />
                )}

                {/* Named for the type, as the reference's blocks of what it is
                    asked with are. */}
                {hasOwnDnsOptions(type) && (
                    <FormSection title={type}>
                        <FilledTextarea
                            id={optionsId}
                            label="Options"
                            rows={8}
                            spellCheck={false}
                            validation={errors.options?.message}
                            {...register("options")}
                        />
                    </FormSection>
                )}

                {type === "hosts" && !isUnreadable && (
                    <PredefinedHosts
                        value={options.predefined}
                        onChange={(predefined) => setOption("predefined", predefined)}
                    />
                )}

                {type === "local" && (
                    <div className={ROW}>
                        <FilledSwitch
                            label="Prefer Go"
                            className={FIELD}
                            disabled={isUnreadable}
                            checked={options.prefer_go === true}
                            onCheckedChange={(on) => setOption("prefer_go", on || undefined)}
                        />
                    </div>
                )}

                {type === "dhcp" && (
                    <div className={ROW}>
                        <FilledTextInput
                            id={interfaceId}
                            label="Interface name"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={isUnreadable}
                            value={text("interface")}
                            onChange={(event) =>
                                setOption("interface", event.target.value || undefined)
                            }
                        />
                    </div>
                )}
            </form>
        </FormDialog>
    );
};
