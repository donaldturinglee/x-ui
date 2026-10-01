import { createContext } from "react";

import type { Operator, SigninRequest } from "@/features/auth/api";

export interface AuthContextValue {
    // Whether the API recognised the session cookie the browser is holding.
    isAuthenticated: boolean;
    // True until the API has answered for the first time. The session is a
    // cookie the panel cannot read, so there is a moment on every load where
    // neither answer is known yet, and turning a visitor away during it would
    // sign out everyone who reloaded.
    isRestoring: boolean;
    operator: Operator | null;
    // Both report what happened rather than throwing, so a caller decides where
    // to go next while the provider keeps the error to show.
    signin: (credentials: SigninRequest) => Promise<boolean>;
    isSigningIn: boolean;
    signinError: Error | null;
    signout: () => Promise<void>;
    isSigningOut: boolean;
}

// There is no session to fall back on outside the provider, so a missing context
// is a mounting mistake rather than a signed out visitor.
export const AuthContext = createContext<AuthContextValue | null>(null);
