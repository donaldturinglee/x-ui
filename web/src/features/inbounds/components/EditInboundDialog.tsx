import { InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";

import {
    fromInbound,
    inboundDocs,
    inboundRequest,
    useUpdateInbound,
    type Inbound,
    type InboundRequest,
} from "../api";

import { InboundFields } from "./InboundFields";

interface EditInboundDialogProps {
    inbound: Inbound;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const EditInboundDialog = ({ inbound, onClose, returnFocusRef }: EditInboundDialogProps) => {
    const formId = useId();
    const { trigger, isMutating, error } = useUpdateInbound();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<InboundRequest>({
        resolver: zodResolver(inboundRequest),
        // What is stored is not quite what is shown: everything the panel does
        // not model arrives flattened alongside the fields that it does, and is
        // gathered back into the document those came out of.
        //
        // No field renders that document whole -- the form holds it and hands
        // it back on submit, which is what carries a listener's transport, its
        // users and whatever a newer core release added through an edit that
        // only meant to change a port. Take it out of here and every save writes
        // a listener stripped to the fields above.
        defaultValues: fromInbound(inbound),
    });
    const type = useWatch({ control, name: "type" });

    const onSubmit = handleSubmit(async (values) => {
        const updated = await trigger({ id: inbound.id, changes: values });

        if (updated) {
            onClose();
        }
    });

    return (
        <FormDialog
            title="Edit listener"
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
                />

                {error && (
                    <InlineMessage variant="critical" className="mt-2.5">
                        {error.message}
                    </InlineMessage>
                )}
            </form>
        </FormDialog>
    );
};
