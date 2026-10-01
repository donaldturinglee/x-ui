import { Spinner } from "@gamecrafters/base-ui/react";
import type { ReactNode } from "react";
import { Navigate } from "react-router";

import { useAuth } from "@/providers/auth/useAuth";

import { getRoutePath } from "./routes";

interface ProtectedRouteProps {
    redirectTo?: string;
    children: ReactNode;
}

// Sign in is where a refused visitor goes unless a caller names somewhere else,
// so the ordinary case says nothing and the path still comes from the table.
export const ProtectedRoute = ({
    redirectTo = getRoutePath("signin"),
    children,
}: ProtectedRouteProps) => {
    const { isAuthenticated, isRestoring } = useAuth();

    // The session is a cookie the panel cannot read, so whether there is one is
    // only known once the API has answered. Turning a visitor away before that
    // lands would sign out everyone who reloaded the page.
    if (isRestoring) {
        return (
            <div className="flex min-h-dvh items-center justify-center">
                <Spinner />
            </div>
        );
    }

    // Turning a visitor away replaces the entry rather than adding one, so going
    // back does not land on the page they were just refused.
    if (!isAuthenticated) {
        return <Navigate to={redirectTo} replace />;
    }

    return children;
};
