import { InlineMessage, SkeletonText } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";

import {
    clientRequest,
    fromClient,
    useClient,
    useUpdateClient,
    type Client,
    type ClientRequest,
} from "../api";

import { ClientTabs } from "./ClientTabs";
import { ResetTrafficDialog } from "./ResetTrafficDialog";

interface EditClientDialogProps {
    client: Client;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// A subscriber is amended from their whole record, read afresh on opening, as
// the reference reads it: the row they were opened from is a summary that
// leaves their credentials out, and a save made without them would have the API
// mint new ones. Until it has been read there is nothing to save.
export const EditClientDialog = ({ client, onClose, returnFocusRef }: EditClientDialogProps) => {
    const formId = useId();
    const [isResetting, setIsResetting] = useState(false);
    const { data: record, error: readError } = useClient(client.id);
    const { trigger, isMutating, error } = useUpdateClient();

    const onSave = async (values: ClientRequest) => {
        const updated = await trigger({ id: client.id, changes: values });

        if (updated) {
            onClose();
        }
    };

    return (
        <FormDialog
            title="Edit Client"
            formId={formId}
            isSaving={isMutating}
            canSave={record !== undefined}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            {record ? (
                <EditClientForm
                    formId={formId}
                    record={record}
                    onSave={onSave}
                    onResetTraffic={() => setIsResetting(true)}
                />
            ) : readError ? (
                <InlineMessage variant="critical" className="my-4">
                    {readError.message}
                </InlineMessage>
            ) : (
                <SkeletonText lines={6} className="my-4" />
            )}

            {error && (
                <InlineMessage variant="critical" className="mt-2">
                    {error.message}
                </InlineMessage>
            )}

            {/* The counters are not in the form, so resetting them leaves what
                was typed here where it is; what they come to afterwards is read
                with the record again. */}
            {isResetting && record && (
                <ResetTrafficDialog client={record} onClose={() => setIsResetting(false)} />
            )}
        </FormDialog>
    );
};

interface EditClientFormProps {
    formId: string;
    // The subscriber as last read. The form starts from the first reading only,
    // so reading them again -- after their traffic is reset, say -- changes what
    // is said about their traffic and not what was typed.
    record: Client;
    onSave: (values: ClientRequest) => Promise<void>;
    onResetTraffic: () => void;
}

const EditClientForm = ({ formId, record, onSave, onResetTraffic }: EditClientFormProps) => {
    const [tab, setTab] = useState("basics");
    const {
        register,
        control,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<ClientRequest>({
        resolver: zodResolver(clientRequest),
        // Every field the API takes, including the listener assignment and the
        // credentials: an update replaces both rather than merging them, so
        // anything the form opens without is something the save takes away.
        defaultValues: fromClient(record),
    });
    const name = useWatch({ control, name: "name" });

    return (
        <form id={formId} onSubmit={handleSubmit(onSave, () => setTab("basics"))} noValidate>
            <ClientTabs
                tab={tab}
                onTabChange={setTab}
                register={register}
                control={control}
                errors={errors}
                setValue={setValue}
                client={record}
                onResetTraffic={onResetTraffic}
            />
            {name !== record.name && (
                <InlineMessage variant="warning" className="my-2">
                    Saving a new name changes the subscription URL. Update the subscription address
                    in client apps after saving.
                </InlineMessage>
            )}
        </form>
    );
};
