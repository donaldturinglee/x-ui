import type { ReactNode } from "react";

import { useMe, useSignin, useSignout, type SigninRequest } from "@/features/auth/api";

import { AuthContext, type AuthContextValue } from "./AuthContext";

interface AuthProviderProps {
    children: ReactNode;
}

export const AuthProvider = ({ children }: AuthProviderProps) => {
    const signin = useSignin();
    const signout = useSignout();
    const me = useMe();

    // The session is a cookie the browser holds and the panel cannot read, so
    // there is nothing to keep in state: whether the API answered this read is
    // the whole of the answer, and signing in or out re-asks it.
    const isAuthenticated = Boolean(me.data);
    const isRestoring = !me.data && !me.error;

    const authenticate = async (credentials: SigninRequest) => {
        const result = await signin.trigger(credentials);

        return Boolean(result);
    };

    // The cookie is cleared by the API either way, so this side is signed out
    // whether or not the call was accepted.
    const endSession = async () => {
        await signout.trigger();
    };

    const value: AuthContextValue = {
        isAuthenticated,
        isRestoring,
        operator: me.data ?? null,
        signin: authenticate,
        isSigningIn: signin.isMutating,
        signinError: signin.error ?? null,
        signout: endSession,
        isSigningOut: signout.isMutating,
    };

    return <AuthContext value={value}>{children}</AuthContext>;
};
