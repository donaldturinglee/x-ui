import { Button, InlineMessage } from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";

import { FilledTextInput } from "@/components/FilledField";
import { useAuth } from "@/providers/auth/useAuth";
import { getRoutePath } from "@/router/routes";

import { isCodeRequired, signinRequest, signinWithCodeRequest, type SigninRequest } from "../api";

interface SigninFormProps {
    showTwoFactor: boolean;
}

export const SigninForm = ({ showTwoFactor }: SigninFormProps) => {
    const usernameId = useId();
    const passwordId = useId();
    const codeId = useId();
    const navigate = useNavigate();
    const { signin, isSigningIn, signinError } = useAuth();

    // Keep the challenge as a fallback if two-factor authentication was enabled
    // after this page loaded. Only that transition focuses the code field.
    const [isCodeAsked, setIsCodeAsked] = useState(false);

    if (!isCodeAsked && isCodeRequired(signinError)) {
        setIsCodeAsked(true);
    }

    const needsCode = showTwoFactor || isCodeAsked;
    const {
        register,
        handleSubmit,
        setFocus,
        formState: { errors },
    } = useForm<SigninRequest>({
        resolver: zodResolver(needsCode ? signinWithCodeRequest : signinRequest),
        defaultValues: {
            username: "",
            password: "",
            code: "",
        },
    });

    useEffect(() => {
        if (isCodeAsked) {
            setFocus("code");
        }
    }, [isCodeAsked, setFocus]);

    // Signing in sets the session cookie, so the panel is only entered once
    // there is one for its requests to carry.
    const onSubmit = handleSubmit(async (values) => {
        const signedIn = await signin({ ...values, code: needsCode ? values.code : "" });

        if (signedIn) {
            await navigate(getRoutePath("overview"));
        }
    });

    // The card it stands in carries the title, so the form is the fields and the
    // button and nothing above them. The fields are the reference's filled ones,
    // each keeping the line under it that says what is missing from it, so the
    // button does not move when something is.
    return (
        <form onSubmit={onSubmit} noValidate>
            <FilledTextInput
                id={usernameId}
                label="Username"
                autoComplete="username"
                spellCheck={false}
                required
                details
                validation={errors.username?.message}
                {...register("username")}
            />
            <FilledTextInput
                id={passwordId}
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                details
                validation={errors.password?.message}
                {...register("password")}
            />

            {needsCode && (
                <FilledTextInput
                    id={codeId}
                    label="Two-factor code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    required
                    details
                    validation={errors.code?.message}
                    {...register("code")}
                />
            )}

            {/* The API answers every failed sign-in the same way, whatever went
                wrong, so that the form cannot be used to find out which
                usernames exist. What it said is shown as it came, above the
                button rather than under either field, since it is about both. */}
            {signinError && !isCodeRequired(signinError) && (
                <InlineMessage variant="critical">{signinError.message}</InlineMessage>
            )}

            <Button
                type="submit"
                variant="primary"
                block
                loading={isSigningIn}
                className="mt-2 h-9 rounded-[4px] text-[14px] shadow-[var(--shadow-resting-small)]"
            >
                Sign in
            </Button>
        </form>
    );
};
