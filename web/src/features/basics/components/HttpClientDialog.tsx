import {
    Dialog,
    FormControl,
    NativeSelect,
    Stack,
    Textarea,
    TextInput,
} from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { Controller, useForm } from "react-hook-form";

import {
    fromHttpClient,
    HTTP_ENGINES,
    HTTP_VERSIONS,
    httpClientRequest,
    toHttpClient,
    type HttpClient,
    type HttpClientRequest,
} from "../api";

interface HttpClientDialogProps {
    // The client being amended, or none for a new one.
    client?: HttpClient;
    // The tags the clients already have, which a new one may not take.
    takenTags: string[];
    // The routes out a client can make its requests through.
    outboundTags: string[];
    onSave: (client: HttpClient) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// A shared HTTP client written into the page, which the page's own Save writes
// into the document. The version, the engine and the route out it goes through
// have fields of their own; the rest -- headers, TLS, how it dials -- is edited
// as the document it is.
//
// The tag is set once: rule sets and a dashboard name
// the client by it.
export const HttpClientDialog = ({
    client,
    takenTags,
    outboundTags,
    onSave,
    onClose,
    returnFocusRef,
}: HttpClientDialogProps) => {
    const formId = useId();
    const tagId = useId();
    const versionId = useId();
    const engineId = useId();
    const detourId = useId();
    const optionsId = useId();
    const {
        register,
        control,
        handleSubmit,
        setError,
        formState: { errors },
    } = useForm<HttpClientRequest>({
        resolver: zodResolver(httpClientRequest),
        defaultValues: client
            ? fromHttpClient(client)
            : { tag: "", version: "0", engine: "", detour: "", options: "" },
    });

    const onSubmit = handleSubmit((values) => {
        if (!client && takenTags.includes(values.tag)) {
            setError("tag", { message: "Another client has this tag." });
            return;
        }

        onSave(toHttpClient(values));
    });

    return (
        <Dialog
            title={client ? "Edit HTTP client" : "Add HTTP client"}
            subtitle={client?.tag ?? "Kept on the page until it is saved."}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
            footerButtons={[
                { content: "Cancel", onClick: onClose },
                {
                    content: client ? "Done" : "Add client",
                    buttonType: "primary",
                    type: "submit",
                    form: formId,
                },
            ]}
        >
            <Stack as="form" id={formId} gap="normal" onSubmit={onSubmit} noValidate>
                <Stack direction="horizontal" gap="normal" wrap="wrap">
                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={tagId} required disabled={Boolean(client)}>
                            <FormControl.Label>Tag</FormControl.Label>
                            <TextInput id={tagId} block autoComplete="off" {...register("tag")} />
                            <FormControl.Caption>
                                {client
                                    ? "What downloads through it names it by this, so it is not changed here."
                                    : "Unique. What downloads through it names it by this."}
                            </FormControl.Caption>
                            {errors.tag && (
                                <FormControl.Validation variant="error">
                                    {errors.tag.message}
                                </FormControl.Validation>
                            )}
                        </FormControl>
                    </Stack.Item>

                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={detourId}>
                            <FormControl.Label>Detour</FormControl.Label>
                            <Controller
                                control={control}
                                name="detour"
                                render={({ field }) => (
                                    <NativeSelect
                                        id={detourId}
                                        block
                                        value={field.value}
                                        onChange={(event) => field.onChange(event.target.value)}
                                    >
                                        <NativeSelect.Option value="">
                                            None — the default route out
                                        </NativeSelect.Option>
                                        {outboundTags.map((tag) => (
                                            <NativeSelect.Option key={tag} value={tag}>
                                                {tag}
                                            </NativeSelect.Option>
                                        ))}
                                        {field.value && !outboundTags.includes(field.value) && (
                                            <NativeSelect.Option value={field.value}>
                                                {field.value} — no longer exists
                                            </NativeSelect.Option>
                                        )}
                                    </NativeSelect>
                                )}
                            />
                        </FormControl>
                    </Stack.Item>
                </Stack>

                <Stack direction="horizontal" gap="normal" wrap="wrap">
                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={versionId}>
                            <FormControl.Label>HTTP version</FormControl.Label>
                            <Controller
                                control={control}
                                name="version"
                                render={({ field }) => (
                                    <NativeSelect
                                        id={versionId}
                                        block
                                        value={field.value}
                                        onChange={(event) => field.onChange(event.target.value)}
                                    >
                                        {HTTP_VERSIONS.map(({ value, name }) => (
                                            <NativeSelect.Option key={value} value={String(value)}>
                                                {name}
                                            </NativeSelect.Option>
                                        ))}
                                    </NativeSelect>
                                )}
                            />
                        </FormControl>
                    </Stack.Item>

                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={engineId}>
                            <FormControl.Label>Engine</FormControl.Label>
                            <Controller
                                control={control}
                                name="engine"
                                render={({ field }) => (
                                    <NativeSelect
                                        id={engineId}
                                        block
                                        value={field.value}
                                        onChange={(event) => field.onChange(event.target.value)}
                                    >
                                        <NativeSelect.Option value="">Default</NativeSelect.Option>
                                        {HTTP_ENGINES.map((engine) => (
                                            <NativeSelect.Option key={engine} value={engine}>
                                                {engine}
                                            </NativeSelect.Option>
                                        ))}
                                        {field.value && !HTTP_ENGINES.includes(field.value) && (
                                            <NativeSelect.Option value={field.value}>
                                                {field.value} — not one this panel knows
                                            </NativeSelect.Option>
                                        )}
                                    </NativeSelect>
                                )}
                            />
                        </FormControl>
                    </Stack.Item>
                </Stack>

                <FormControl id={optionsId}>
                    <FormControl.Label>Options</FormControl.Label>
                    <Textarea
                        id={optionsId}
                        block
                        rows={8}
                        spellCheck={false}
                        className="font-mono"
                        validationStatus={errors.options && "error"}
                        {...register("options")}
                    />
                    <FormControl.Caption>
                        Everything else the core accepts on a client, as JSON — headers, tls,
                        disable_version_fallback, and how it dials. Leave it empty for none.
                    </FormControl.Caption>
                    {errors.options && (
                        <FormControl.Validation variant="error">
                            {errors.options.message}
                        </FormControl.Validation>
                    )}
                </FormControl>
            </Stack>
        </Dialog>
    );
};
