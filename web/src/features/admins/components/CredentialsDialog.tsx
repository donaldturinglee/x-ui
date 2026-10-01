import { InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, type RefObject } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";

import { FilledTextInput } from "@/components/FilledField";
import { FormDialog } from "@/components/FormDialog";
import {
    credentialsRequest,
    useChangeCredentials,
    type CredentialsRequest,
} from "@/features/auth/api";
import { getRoutePath } from "@/router/routes";

interface CredentialsDialogProps {
    // The account signed in, whose credentials these are: the API changes the
    // session's own and no other.
    username: string;
    onClose: () => void;
    // Closing hands focus back to what opened the dialog, so the page is left
    // where it was.
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// Changing your own username and password, which is the only way either changes
// from inside the panel: there is no operator management, and `x-ui-cli
// admin` is the recovery path for when nobody can sign in at all. Laid out as the
// reference's is: a narrow dialog of filled fields, one to a row, each keeping
// the line under it for what is wrong with it, so nothing moves when something
// is.
//
// The current password is asked for even though the session proves who is signed
// in: it proves the person at the keyboard is still them. The new one is asked
// for twice, which the reference does not ask: it is not shown, and a typo would
// lock the operator out of the panel they were securing.
//
// On success the API has ended the session, so the panel drops what it read
// under it and leaves for sign in, as signing out does, where the credentials
// just set are the ones to come back with.
export const CredentialsDialog = ({
    username,
    onClose,
    returnFocusRef,
}: CredentialsDialogProps) => {
    const formId = useId();
    const oldPasswordId = useId();
    const newUsernameId = useId();
    const newPasswordId = useId();
    const confirmPasswordId = useId();
    const navigate = useNavigate();

    const { trigger, isMutating, error } = useChangeCredentials();
    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<CredentialsRequest>({
        resolver: zodResolver(credentialsRequest),
        // The username is carried in rather than left empty, so changing the
        // password alone takes only the passwords.
        defaultValues: {
            oldPassword: "",
            newUsername: username,
            newPassword: "",
            confirmPassword: "",
        },
    });

    const onSubmit = handleSubmit(async (values) => {
        if (await trigger(values)) {
            await navigate(getRoutePath("signin"));
        }
    });

    return (
        <FormDialog
            title={`Change credentials ${username}`}
            formId={formId}
            isSaving={isMutating}
            isBodyPadded
            width={400}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                {/* Rows eight pixels apart, as the reference's are. */}
                <div className="flex flex-col gap-2">
                    <FilledTextInput
                        id={oldPasswordId}
                        label="Current password"
                        type="password"
                        autoComplete="current-password"
                        required
                        details
                        validation={errors.oldPassword?.message}
                        {...register("oldPassword")}
                    />
                    <FilledTextInput
                        id={newUsernameId}
                        label="New username"
                        autoComplete="username"
                        spellCheck={false}
                        required
                        details
                        validation={errors.newUsername?.message}
                        {...register("newUsername")}
                    />
                    <FilledTextInput
                        id={newPasswordId}
                        label="New password"
                        type="password"
                        autoComplete="new-password"
                        required
                        details
                        validation={errors.newPassword?.message}
                        {...register("newPassword")}
                    />
                    <FilledTextInput
                        id={confirmPasswordId}
                        label="New password again"
                        type="password"
                        autoComplete="new-password"
                        required
                        details
                        validation={errors.confirmPassword?.message}
                        {...register("confirmPassword")}
                    />
                </div>

                {/* The API is the authority on the current password and on
                    whether the new username is taken, so what it refused is read
                    here rather than beside a field. */}
                {error && (
                    <InlineMessage variant="critical" className="mt-2">
                        {error.message}
                    </InlineMessage>
                )}
            </form>
        </FormDialog>
    );
};
