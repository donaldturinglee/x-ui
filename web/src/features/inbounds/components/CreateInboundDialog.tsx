import { InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";

import { inboundDocs, inboundRequest, useCreateInbound, type InboundRequest } from "../api";

import { InboundFields } from "./InboundFields";

interface CreateInboundDialogProps {
    onClose: () => void;
    // Closing hands focus back to whatever opened the dialog, so the page is
    // left where it was rather than back at the top of the document.
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const CreateInboundDialog = ({ onClose, returnFocusRef }: CreateInboundDialogProps) => {
    const formId = useId();
    const { trigger, isMutating, error } = useCreateInbound();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<InboundRequest>({
        resolver: zodResolver(inboundRequest),
        // The type and port still need an explicit choice. A new listener's
        // address starts at the all-interface IPv6 bind address.
        defaultValues: {
            type: "",
            tag: "",
            listen: "::",
            listen_port: 0,
            security: "none",
            options: "",
        },
    });
    const type = useWatch({ control, name: "type" });

    // The listener is written before the dialog closes, so a refused one leaves
    // what was typed where it is to be put right rather than dropping it.
    const onSubmit = handleSubmit(async (values) => {
        const created = await trigger(values);

        if (created) {
            onClose();
        }
    });

    return (
        <FormDialog
            title="Add inbound"
            docs={inboundDocs(type)}
            formId={formId}
            isSaving={isMutating}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                <InboundFields
                    register={register}
                    control={control}
                    errors={errors}
                    setValue={setValue}
                    newListenDefault="::"
                />

                {/* The API is the authority on whether a listener may be written
                    — a duplicate tag, a type the core does not know — so what it
                    refused is read here rather than beside a field. */}
                {error && (
                    <InlineMessage variant="critical" className="mt-2.5">
                        {error.message}
                    </InlineMessage>
                )}
            </form>
        </FormDialog>
    );
};
