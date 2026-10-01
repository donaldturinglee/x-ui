import {
    Button,
    Clipboard,
    InlineMessage,
    QRCode,
    SkeletonText,
    Text,
} from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId } from "react";
import { useForm } from "react-hook-form";

import { FilledTextInput } from "@/components/FilledField";
import {
    twoFactorCodeRequest,
    useDisableTwoFactor,
    useEnableTwoFactor,
    useMe,
    useSetupTwoFactor,
    type TwoFactorCodeRequest,
} from "@/features/auth/api";

import { FOOTER, PLAIN_BUTTON, RESTORE_BUTTON, SAVE_BUTTON } from "./layout";

// A secret is read off the screen and typed into an app far more often than it
// is copied, so it is shown in groups of four, the way apps show one.
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? secret;

const TEXT = "m-0 text-[14px] leading-5";

// Two-factor authentication for the signed-in operator's own account: after the
// password, sign-in asks for the code an authenticator app shows. Another
// operator's is theirs to turn on, as their credentials are theirs to change.
//
// Turning it on is three steps in one place: the app is given a secret by the QR
// code or by hand, shows a code for it, and the code is typed back -- which is
// what proves the app has the secret before sign-in starts to depend on it.
// Turning it off takes a code too, so a session left open on an unattended
// screen is not enough to take the second factor away.
export const TwoFactorTab = () => {
    const codeId = useId();
    const secretId = useId();

    const { data: me, mutate: reloadMe } = useMe();
    const {
        trigger: setup,
        data: pending,
        isMutating: isSettingUp,
        error: setupError,
        reset: cancelSetup,
    } = useSetupTwoFactor();
    const { trigger: enable, isMutating: isEnabling, error: enableError } = useEnableTwoFactor();
    const {
        trigger: disable,
        isMutating: isDisabling,
        error: disableError,
    } = useDisableTwoFactor();
    const {
        register,
        handleSubmit,
        reset: clearCode,
        formState: { errors },
    } = useForm<TwoFactorCodeRequest>({
        resolver: zodResolver(twoFactorCodeRequest),
        defaultValues: { code: "" },
    });

    // The account is read again before the secret is let go, so the tab goes
    // straight from the QR code to saying it is on, rather than back to "Set up"
    // for the moment the read takes.
    const onSubmit = handleSubmit(async (values) => {
        const changed = me?.twoFactor
            ? await disable(values)
            : pending && (await enable({ secret: pending.secret, code: values }));

        if (changed) {
            await reloadMe();
            clearCode();
            cancelSetup();
        }
    });

    const codeField = (
        <FilledTextInput
            id={codeId}
            label="Code from your app"
            className="min-[600px]:w-[calc((100%_-_8px)/2)] min-[840px]:w-[calc((100%_-_16px)/3)]"
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            details
            validation={errors.code?.message}
            {...register("code")}
        />
    );

    if (!me) {
        return (
            <div className="p-4">
                <SkeletonText lines={2} />
            </div>
        );
    }

    return (
        <form
            aria-label="Two-factor authentication"
            onSubmit={(event) => void onSubmit(event)}
            noValidate
        >
            <div className="flex flex-col gap-4 p-4">
                {me.twoFactor ? (
                    <>
                        <Text as="p" className={TEXT}>
                            Two-factor authentication is on for {me.username}: signing in asks for
                            the code your authenticator app shows, after the password. To turn it
                            off, enter the code the app shows now.
                        </Text>
                        {codeField}
                    </>
                ) : pending ? (
                    <>
                        <Text as="p" className={TEXT}>
                            Scan the code with your authenticator app, or type the secret into it,
                            then enter the code the app shows to turn two-factor authentication on.
                        </Text>

                        <div className="flex flex-wrap items-center gap-4">
                            {/* Scanned rather than typed, as a subscription's is:
                                the secret is long, and one character wrong is an
                                app that never shows a code that works. */}
                            <QRCode
                                value={pending.uri}
                                size={160}
                                aria-label={`QR code for ${me.username}'s authenticator app`}
                            />

                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                <FilledTextInput
                                    id={secretId}
                                    label="Secret"
                                    className="min-w-0 flex-1"
                                    readOnly
                                    spellCheck={false}
                                    value={grouped(pending.secret)}
                                />
                                <Clipboard value={pending.secret}>
                                    <Clipboard.Trigger label="Copy the secret" />
                                </Clipboard>
                            </div>
                        </div>

                        {codeField}
                    </>
                ) : (
                    <Text as="p" className={TEXT}>
                        Two-factor authentication is off for {me.username}. Turned on, signing in
                        asks for the code an authenticator app shows as well as the password, so the
                        password alone no longer opens the panel.
                    </Text>
                )}

                {/* What the API refused is said as it came: a code that does not
                    match is usually a phone whose clock has drifted. */}
                {[setupError, enableError, disableError].map(
                    (error) =>
                        error && (
                            <InlineMessage key={error.message} variant="critical">
                                {error.message}
                            </InlineMessage>
                        ),
                )}
            </div>

            <div className={FOOTER}>
                {me.twoFactor ? (
                    <Button type="submit" loading={isDisabling} className={RESTORE_BUTTON}>
                        Turn off
                    </Button>
                ) : pending ? (
                    <>
                        <Button
                            type="button"
                            disabled={isEnabling}
                            className={PLAIN_BUTTON}
                            onClick={() => {
                                clearCode();
                                cancelSetup();
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            loading={isEnabling}
                            className={SAVE_BUTTON}
                        >
                            Turn on
                        </Button>
                    </>
                ) : (
                    <Button
                        type="button"
                        variant="primary"
                        loading={isSettingUp}
                        className={SAVE_BUTTON}
                        onClick={() => void setup()}
                    >
                        Set up
                    </Button>
                )}
            </div>
        </form>
    );
};
