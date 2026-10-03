import { InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState, type RefObject } from "react";
import { useForm } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";

import { clientRequest, useCreateClient, withIdentityDrawn, type ClientRequest } from "../api";

import { ClientTabs } from "./ClientTabs";

interface CreateClientDialogProps {
    onClose: () => void;
    // Closing hands focus back to whatever opened the dialog, so the page is
    // left where it was rather than back at the top of the document.
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const CreateClientDialog = ({ onClose, returnFocusRef }: CreateClientDialogProps) => {
    const formId = useId();
    const [tab, setTab] = useState("basics");
    // Drawn once, as the dialog opens, rather than on every render of it.
    const [config] = useState(() => withIdentityDrawn({}));
    const { trigger, isMutating, error } = useCreateClient();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<ClientRequest>({
        resolver: zodResolver(clientRequest),
        // A subscriber opens enabled and unlimited: the quota and the expiry are
        // what a seller chooses, and defaulting either to a limit would sell
        // somebody a subscription that had already run out. They open with a
        // credential for every protocol, as the reference draws them.
        defaultValues: {
            name: "",
            enable: true,
            desc: "",
            group: "",
            volume: 0,
            expiry: "",
            delayStart: false,
            autoReset: false,
            resetDays: 0,
            inbounds: [],
            config,
        },
    });

    // The subscriber is written before the dialog closes, so a refused one
    // leaves what was typed where it is to be put right rather than dropping it.
    // What the form refuses is on the first tab, which is brought back to show
    // it.
    const onSubmit = handleSubmit(
        async (values) => {
            const created = await trigger(values);

            if (created) {
                onClose();
            }
        },
        () => setTab("basics"),
    );

    return (
        <FormDialog
            title="Add client"
            formId={formId}
            isSaving={isMutating}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                <ClientTabs
                    tab={tab}
                    onTabChange={setTab}
                    register={register}
                    control={control}
                    errors={errors}
                    setValue={setValue}
                />

                {/* The API is the authority on whether a subscriber may be
                    written, so what it refused is read here rather than beside a
                    field. */}
                {error && (
                    <InlineMessage variant="critical" className="mt-2">
                        {error.message}
                    </InlineMessage>
                )}
            </form>
        </FormDialog>
    );
};
