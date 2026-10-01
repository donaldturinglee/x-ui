import { NativeSelect } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { FilledSelect, FilledTextarea, FilledTextInput } from "@/components/FilledField";
import { FormDialog } from "@/components/FormDialog";
import { useOutbounds } from "@/features/outbounds/api";

import {
    fromRuleSet,
    isPlainDirect,
    parseDocument,
    RULE_SET_FORMATS,
    RULE_SET_TYPES,
    ruleSetRequest,
    toRuleSet,
    type RuleSet,
    type RuleSetRequest,
} from "../api";

interface RuleSetDialogProps {
    // The existing rule set being amended.
    ruleSet: RuleSet;
    // What a remote one can be downloaded over: a shared client, or a route out.
    httpClientTags: string[];
    outboundTags: string[];
    onSave: (ruleSet: RuleSet) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";
const WHOLE = "col-span-12";

// Where the proxy core documents rule sets, as the mark in the title leads to it.
const RULE_SET_DOCS = {
    href: "https://sing-box.sagernet.org/configuration/rule-set/",
    label: "Rule set",
};

// What each kind keeps of the others' options when it is switched to: none of
// them, as the reference lets go of a remote one's address when it is made local
// and a local one's path when it is made remote.
const KIND_KEYS: Record<string, string[]> = {
    local: ["path"],
    remote: ["url", "http_client", "update_interval"],
    inline: ["rules"],
};

// A rule set written into the page, which the page's own Save writes into the
// document, laid out as the reference lays it out: its kind, tag and format,
// then where a local one is kept, or where a remote one is fetched from, over
// what and how often. Those are read off the options the rest of it is stored
// with; an inline one's rules are written out as the document they are.
//
// The tag is set once: rules name the rule set by it, and so may parts of the
// document this page never shows.
export const RuleSetDialog = ({
    ruleSet,
    httpClientTags,
    outboundTags,
    onSave,
    onClose,
    returnFocusRef,
}: RuleSetDialogProps) => {
    const { data: outbounds } = useOutbounds();
    const formId = useId();
    const typeId = useId();
    const tagId = useId();
    const formatId = useId();
    const pathId = useId();
    const urlId = useId();
    const httpClientId = useId();
    const detourId = useId();
    const intervalId = useId();
    const optionsId = useId();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<RuleSetRequest>({
        resolver: zodResolver(ruleSetRequest),
        defaultValues: fromRuleSet(ruleSet),
    });

    const [type, format, document] = useWatch({ control, name: ["type", "format", "options"] });
    const options = parseDocument(document) ?? {};
    const client = options.http_client;

    const setOptions = (next: Record<string, unknown>) =>
        setValue("options", Object.keys(next).length ? JSON.stringify(next, null, 4) : "", {
            shouldDirty: true,
        });
    const setOption = (key: string, value: unknown) => setOptions({ ...options, [key]: value });
    const text = (key: string) => (typeof options[key] === "string" ? options[key] : "");

    // A shared client named replaces a route out to download over, and the other
    // way round: the core takes one or the other.
    const clientTag = typeof client === "string" ? client : "";
    const detour =
        typeof client === "object" && client !== null && "detour" in client
            ? String((client as { detour?: unknown }).detour ?? "")
            : "";
    const interval = /^(\d+)d$/.exec(text("update_interval"));

    const onSubmit = handleSubmit((values) => {
        onSave(toRuleSet(values));
    });

    return (
        <FormDialog
            title="Edit rule set"
            docs={RULE_SET_DOCS}
            formId={formId}
            isSaving={false}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                <div className="flex flex-col gap-2">
                    <div className={ROW}>
                        <Controller
                            control={control}
                            name="type"
                            render={({ field }) => (
                                <FilledSelect
                                    id={typeId}
                                    label="Type"
                                    className={FIELD}
                                    ref={field.ref}
                                    value={field.value}
                                    onChange={(event) => {
                                        const next = event.target.value;

                                        field.onChange(next);
                                        setOptions(
                                            Object.fromEntries(
                                                Object.entries(options).filter(
                                                    ([key]) =>
                                                        !Object.entries(KIND_KEYS).some(
                                                            ([kind, keys]) =>
                                                                kind !== next && keys.includes(key),
                                                        ),
                                                ),
                                            ),
                                        );
                                        // An inline one is written in the
                                        // document itself and has no format;
                                        // the others keep the one they have.
                                        if (next === "inline") {
                                            setValue("format", "");
                                        } else if (!format) {
                                            setValue("format", "binary");
                                        }
                                    }}
                                >
                                    {RULE_SET_TYPES.map(({ value, name }) => (
                                        <NativeSelect.Option key={value} value={value}>
                                            {name}
                                        </NativeSelect.Option>
                                    ))}
                                    {!RULE_SET_TYPES.some(({ value }) => value === field.value) && (
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
                            disabled
                            validation={errors.tag?.message}
                            {...register("tag")}
                        />

                        <Controller
                            control={control}
                            name="format"
                            render={({ field }) => (
                                <FilledSelect
                                    id={formatId}
                                    label="Data format"
                                    className={FIELD}
                                    ref={field.ref}
                                    value={field.value}
                                    onChange={(event) => field.onChange(event.target.value)}
                                >
                                    {!field.value && (
                                        <NativeSelect.Option value="">None</NativeSelect.Option>
                                    )}
                                    {RULE_SET_FORMATS.map((format) => (
                                        <NativeSelect.Option key={format} value={format}>
                                            {format}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                            )}
                        />
                    </div>

                    {type === "local" && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={pathId}
                                label="Path"
                                className={WHOLE}
                                autoComplete="off"
                                spellCheck={false}
                                value={text("path")}
                                onChange={(event) => setOption("path", event.target.value)}
                            />
                        </div>
                    )}

                    {type === "remote" && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={urlId}
                                label="URL"
                                className={WHOLE}
                                type="url"
                                autoComplete="off"
                                spellCheck={false}
                                value={text("url")}
                                onChange={(event) => setOption("url", event.target.value)}
                            />
                            <FilledSelect
                                id={httpClientId}
                                label="HTTP client"
                                className={FIELD}
                                value={clientTag}
                                onChange={(event) =>
                                    setOption("http_client", event.target.value || undefined)
                                }
                            >
                                <NativeSelect.Option value="">
                                    {httpClientTags.length ? "None" : "None defined"}
                                </NativeSelect.Option>
                                {httpClientTags.map((tag) => (
                                    <NativeSelect.Option key={tag} value={tag}>
                                        {tag}
                                    </NativeSelect.Option>
                                ))}
                                {clientTag && !httpClientTags.includes(clientTag) && (
                                    <NativeSelect.Option value={clientTag}>
                                        {clientTag} — no longer exists
                                    </NativeSelect.Option>
                                )}
                            </FilledSelect>
                            {/* A plain direct route out dials what no detour dials,
                                and the core refuses it as one, so choosing it is
                                choosing none. */}
                            <FilledSelect
                                id={detourId}
                                label="Outbound"
                                className={FIELD}
                                value={detour}
                                onChange={(event) => {
                                    const tag = event.target.value;
                                    const outbound = outbounds?.find(
                                        (candidate) => candidate.tag === tag,
                                    );

                                    setOption(
                                        "http_client",
                                        tag && !isPlainDirect(outbound)
                                            ? { detour: tag }
                                            : undefined,
                                    );
                                }}
                            >
                                <NativeSelect.Option value="">None</NativeSelect.Option>
                                {outboundTags.map((tag) => (
                                    <NativeSelect.Option key={tag} value={tag}>
                                        {tag}
                                    </NativeSelect.Option>
                                ))}
                                {detour && !outboundTags.includes(detour) && (
                                    <NativeSelect.Option value={detour}>
                                        {detour} — no longer exists
                                    </NativeSelect.Option>
                                )}
                            </FilledSelect>
                            {/* Written as the core writes it, in days, and taken
                                out when cleared. */}
                            <FilledTextInput
                                id={intervalId}
                                label="Update interval (days)"
                                className={FIELD}
                                type="number"
                                inputMode="numeric"
                                min={0}
                                value={interval ? interval[1] : ""}
                                onChange={(event) => {
                                    const days = Number(event.target.value);

                                    setOption("update_interval", days > 0 ? `${days}d` : undefined);
                                }}
                            />
                        </div>
                    )}

                    {type !== "local" && type !== "remote" && (
                        <div className={ROW}>
                            <FilledTextarea
                                id={optionsId}
                                label="Options"
                                className={WHOLE}
                                rows={8}
                                spellCheck={false}
                                validation={errors.options?.message}
                                {...register("options")}
                            />
                        </div>
                    )}
                </div>
            </form>
        </FormDialog>
    );
};
