import { InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";

import {
    editOutboundRequest,
    fromOutbound,
    outboundDocs,
    useUpdateOutbound,
    type Outbound,
    type OutboundRequest,
} from "../api";

import { OutboundFields } from "./OutboundFields";

interface EditOutboundDialogProps {
    outbound: Outbound;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const EditOutboundDialog = ({
    outbound,
    onClose,
    returnFocusRef,
}: EditOutboundDialogProps) => {
    const formId = useId();
    const { trigger, isMutating, error } = useUpdateOutbound();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<OutboundRequest>({
        resolver: zodResolver(editOutboundRequest),
        // Options the panel does not display remain in the form's document and
        // are sent back alongside edits to the fields it does display.
        defaultValues: fromOutbound(outbound),
    });
    const type = useWatch({ control, name: "type" });

    const onSubmit = handleSubmit(async (values) => {
        const updated = await trigger({ id: outbound.id, changes: values });

        if (updated) {
            onClose();
        }
    });

    return (
        <FormDialog
            title="Edit Outbound"
            docs={outboundDocs(type)}
            formId={formId}
            isSaving={isMutating}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                <OutboundFields
                    register={register}
                    control={control}
                    errors={errors}
                    setValue={setValue}
                />

                {error && (
                    <InlineMessage variant="critical" className="mt-2">
                        {error.message}
                    </InlineMessage>
                )}
            </form>
        </FormDialog>
    );
};
