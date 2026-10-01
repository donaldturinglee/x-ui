import { use } from "react";

import { AuthContext } from "./AuthContext";

export const useAuth = () => {
    const value = use(AuthContext);

    if (!value) {
        throw new Error("useAuth must be used within an AuthProvider.");
    }

    return value;
};
