import { InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";

import {
    createOutboundRequest,
    outboundDocs,
    useCreateOutbound,
    type OutboundRequest,
} from "../api";

import { OutboundFields } from "./OutboundFields";

interface CreateOutboundDialogProps {
    onClose: () => void;
    // Closing hands focus back to whatever opened the dialog, so the page is
    // left where it was rather than back at the top of the document.
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const CreateOutboundDialog = ({ onClose, returnFocusRef }: CreateOutboundDialogProps) => {
    const formId = useId();
    const { trigger, isMutating, error } = useCreateOutbound();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<OutboundRequest>({
        resolver: zodResolver(createOutboundRequest),
        // Nothing is filled in for the operator: where traffic goes is what an
        // outbound is, and a default would be a node quietly routing somewhere
        // nobody chose.
        defaultValues: {
            type: "",
            tag: "",
            options: "",
        },
    });
    const type = useWatch({ control, name: "type" });

    // The route is written before the dialog closes, so a refused one leaves
    // what was typed where it is to be put right rather than dropping it.
    const onSubmit = handleSubmit(async (values) => {
        const created = await trigger(values);

        if (created) {
            onClose();
        }
    });

    return (
        <FormDialog
            title="Add Outbound"
            docs={outboundDocs(type)}
            formId={formId}
            isSaving={isMutating}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                {/* The fields alone: the reference's second tab, which reads a
                    share link into them, is left out. */}
                <OutboundFields
                    register={register}
                    control={control}
                    errors={errors}
                    setValue={setValue}
                />

                {/* The API is the authority on whether a route may be written —
                    a duplicate tag, a type the core does not know — so what it
                    refused is read here rather than beside a field. */}
                {error && (
                    <InlineMessage variant="critical" className="mt-2">
                        {error.message}
                    </InlineMessage>
                )}
            </form>
        </FormDialog>
    );
};
