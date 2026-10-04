import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { request, RequestError } from "@/lib/request";

// A panel operator, as /me describes one. The password hash never leaves the
// API, so there is nothing of it here to leak; nor does the two-factor secret,
// which is said to be there or not and nothing more.
export interface Operator {
    id: number;
    username: string;
    // The last successful sign-in, as "2006-01-02 15:04:05 <ip>". Empty for an
    // account that has never been used.
    lastSignIn: string;
    createdAt: number;
    // Whether signing in to the account takes a code from an authenticator app
    // as well as the password.
    twoFactor: boolean;
}

export const ME_KEY = "/me";

export interface SigninConfig {
    showTwoFactor: boolean;
}

const SIGNIN_CONFIG_KEY = "/signin/config";

export const useSigninConfig = () =>
    useSWR<SigninConfig, Error>(
        SIGNIN_CONFIG_KEY,
        () => request.get<SigninConfig>(SIGNIN_CONFIG_KEY),
        {
            // Read current state on every visit, including after signing out.
            revalidateOnMount: true,
            revalidateOnFocus: false,
            revalidateOnReconnect: false,
            dedupingInterval: 0,
            shouldRetryOnError: false,
        },
    );

// Where the accounts are listed, which the admins page reads. Named here as
// well, since turning two-factor authentication on or off changes a card there.
const USERS_KEY = "/users";

// Six digits, as every authenticator app shows them -- with a space in the
// middle, the way some do, taken as typed.
const CODE = /^\d{6}$/;

export const normaliseCode = (code: string) => code.replace(/\s/g, "");

const codeField = z
    .string()
    .refine((code) => CODE.test(normaliseCode(code)), "Enter the six digits your app shows.");

// Signing in is the only write the panel makes without a session, and it is the
// one that creates it. What is checked here is that there is something to send
// rather than a second opinion on the credentials: the API is the authority on
// whether they are right, and what it refuses is read back from it.
//
// A password-only sign-in has no code. The login configuration, or a challenge
// returned after it changed, selects the required-code schema below.
export const signinRequest = z.object({
    username: z.string().min(1, "Enter your username."),
    password: z.string().min(1, "Enter your password."),
    code: z
        .string()
        .refine(
            (code) => !code.trim() || CODE.test(normaliseCode(code)),
            "Enter the six digits your app shows.",
        ),
});

export const signinWithCodeRequest = signinRequest.extend({ code: codeField });

export type SigninRequest = z.infer<typeof signinRequest>;

// Whether a refused sign-in was the API asking for the code: the password was
// right, and the account takes a code from an authenticator app as well. It is
// said in the refusal's payload rather than only in its sentence, which is what
// the form branches on.
export const isCodeRequired = (error: unknown) =>
    error instanceof RequestError &&
    typeof error.obj === "object" &&
    error.obj !== null &&
    (error.obj as Record<string, unknown>).twoFactor === true;

// The shortest password the API will take, and the longest. Past 72 bytes bcrypt
// silently ignores the rest, so a longer one is not the password that was set.
export const MINIMUM_PASSWORD_LENGTH = 8;
export const MAXIMUM_PASSWORD_BYTES = 72;

// Changing your own credentials. The account comes from the session and never
// from the request, so there is nothing here naming who is being changed.
//
// The current password is asked for even though the session already proves who
// is at the keyboard: it proves it is still them, and an unattended screen is
// exactly how an account is taken over.
export const credentialsRequest = z
    .object({
        oldPassword: z.string().min(1, "Enter your current password."),
        newUsername: z.string().min(1, "Enter a username.").max(64, "Use 64 characters or fewer."),
        newPassword: z
            .string()
            .min(MINIMUM_PASSWORD_LENGTH, `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`)
            .max(MAXIMUM_PASSWORD_BYTES, `Use ${MAXIMUM_PASSWORD_BYTES} characters or fewer.`),
        confirmPassword: z.string(),
    })
    .refine((values) => values.newPassword === values.confirmPassword, {
        // Typed twice because it is not shown: a typo would otherwise lock the
        // operator out of the panel they were securing.
        message: "The two passwords are not the same.",
        path: ["confirmPassword"],
    });

export type CredentialsRequest = z.infer<typeof credentialsRequest>;

export const getMe = async () => {
    return request.get<Operator>(ME_KEY);
};

// Whether there is a session is something only the API can answer: it is a
// cookie the panel cannot read. This read is the answer, so it is asked for
// unconditionally and a refusal is what "signed out" looks like.
export const useMe = () => {
    return useSWR<Operator, Error>(ME_KEY, getMe, {
        // A 401 is the ordinary signed-out answer, not a fault worth retrying
        // three times on every load of the sign-in page.
        shouldRetryOnError: false,
    });
};

// A code is sent as the digits alone; an empty code is left out.
export const signin = async ({ code, ...credentials }: SigninRequest) => {
    return request.post<{ username: string }>("/signin", {
        ...credentials,
        ...(code.trim() ? { code: normaliseCode(code) } : {}),
    });
};

export const useSignin = () => {
    const { mutate } = useSWRConfig();

    return useSWRMutation(
        "/signin",
        (_key: string, { arg }: { arg: SigninRequest }) => signin(arg),
        {
            throwOnError: false,
            // The session now exists, so everything that was refused without one is
            // worth asking for again.
            onSuccess: () => mutate(() => true),
        },
    );
};

// The confirmation never leaves the panel: the API asks for the new password
// once, and what the second field is for is catching a typo before it is set.
//
// The API answers a change with nothing, so it is said here that one landed, for
// the form that asked to act on.
export const changeCredentials = async ({
    confirmPassword,
    ...credentials
}: CredentialsRequest) => {
    void confirmPassword;

    await request.post<null>(`${ME_KEY}/credentials`, credentials);

    return true;
};

// The API clears the session on success, so everything read under it is dropped
// without being asked for again, and the form that asked leaves for the sign-in
// page, as signing out does -- which is the right end to this: the credentials
// that were just changed are the ones to come back with.
export const useChangeCredentials = () => {
    const { mutate } = useSWRConfig();

    return useSWRMutation(
        `${ME_KEY}/credentials`,
        (_key: string, { arg }: { arg: CredentialsRequest }) => changeCredentials(arg),
        {
            throwOnError: false,
            onSuccess: () => mutate(() => true, undefined, { revalidate: false }),
        },
    );
};

// Two-factor authentication for the signed-in operator's own account. The API
// hands out a secret and the otpauth:// address an authenticator app scans it
// from, and stores it only once a code from the app has confirmed it; turning
// it off takes a code as well.
export interface TwoFactorSetup {
    secret: string;
    uri: string;
}

const TWO_FACTOR_KEY = `${ME_KEY}/two-factor`;

export const twoFactorCodeRequest = z.object({ code: codeField });

export type TwoFactorCodeRequest = z.infer<typeof twoFactorCodeRequest>;

// The account's own card and the answer to /me both say whether it is on, so
// both are asked for again once it has changed.
const useRevalidateOperators = () => {
    const { mutate } = useSWRConfig();

    return () => mutate((key) => key === ME_KEY || key === USERS_KEY);
};

export const setupTwoFactor = async () => {
    return request.post<TwoFactorSetup>(`${TWO_FACTOR_KEY}/setup`);
};

export const useSetupTwoFactor = () => {
    return useSWRMutation(`${TWO_FACTOR_KEY}/setup`, () => setupTwoFactor(), {
        throwOnError: false,
    });
};

// The API answers with a sentence rather than a record, so it is said here that
// the change landed, for the tab that asked to act on.
export const enableTwoFactor = async (secret: string, { code }: TwoFactorCodeRequest) => {
    await request.post<null>(`${TWO_FACTOR_KEY}/enable`, { secret, code: normaliseCode(code) });

    return true;
};

export const useEnableTwoFactor = () => {
    const revalidate = useRevalidateOperators();

    return useSWRMutation(
        `${TWO_FACTOR_KEY}/enable`,
        (_key: string, { arg }: { arg: { secret: string; code: TwoFactorCodeRequest } }) =>
            enableTwoFactor(arg.secret, arg.code),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const disableTwoFactor = async ({ code }: TwoFactorCodeRequest) => {
    await request.post<null>(`${TWO_FACTOR_KEY}/disable`, { code: normaliseCode(code) });

    return true;
};

export const useDisableTwoFactor = () => {
    const revalidate = useRevalidateOperators();

    return useSWRMutation(
        `${TWO_FACTOR_KEY}/disable`,
        (_key: string, { arg }: { arg: TwoFactorCodeRequest }) => disableTwoFactor(arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

// An API token authenticates a script the way the session cookie authenticates a
// browser. The secret is masked everywhere except the response that mints it, so
// the panel shows it once and never again — and says so.
export interface Token {
    id: number;
    desc: string;
    token: string;
    expiry: number;
    userId: number;
    createdAt: number;
}

export const TOKENS_KEY = "/tokens";

// The longest a token may be minted for. Past a year it is not a token an
// operator is keeping track of.
export const MAXIMUM_TOKEN_DAYS = 365;

export const tokenRequest = z.object({
    desc: z.string().min(1, "Say what it is for.").max(200, "Use 200 characters or fewer."),
    // Zero mints one that does not expire, which the API allows and an operator
    // should have to choose rather than arrive at by leaving a field alone.
    expiryDays: z
        .number("Use a whole number of days.")
        .int("Use a whole number of days.")
        .min(0, "Use nothing less than zero.")
        .max(MAXIMUM_TOKEN_DAYS, `Use ${MAXIMUM_TOKEN_DAYS} or fewer.`),
});

export type TokenRequest = z.infer<typeof tokenRequest>;

export const useTokens = () => {
    return useSWR<Token[], Error>(TOKENS_KEY, () => request.get<Token[]>(TOKENS_KEY));
};

const useRevalidateTokens = () => {
    const { mutate } = useSWRConfig();

    return () => mutate(TOKENS_KEY);
};

export const useCreateToken = () => {
    const revalidate = useRevalidateTokens();

    return useSWRMutation(
        TOKENS_KEY,
        (key: string, { arg }: { arg: TokenRequest }) => request.post<Token>(key, arg),
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const useDeleteToken = () => {
    const revalidate = useRevalidateTokens();

    return useSWRMutation(
        TOKENS_KEY,
        async (key: string, { arg }: { arg: number }) => {
            await request.delete(`${key}/${arg}`);

            return arg;
        },
        {
            throwOnError: false,
            onSuccess: revalidate,
        },
    );
};

export const signout = async () => {
    return request.post<null>("/signout");
};

export const useSignout = () => {
    const { mutate } = useSWRConfig();

    return useSWRMutation("/signout", () => signout(), {
        throwOnError: false,
        // Everything fetched under the old session goes with it, so none of it
        // is left on screen for the next person to read.
        onSuccess: () => mutate(() => true, undefined, { revalidate: false }),
    });
};
