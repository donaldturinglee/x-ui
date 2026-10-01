import type { ComponentType } from "react";

import { ProtectedRoute } from "./ProtectedRoute";
import type { RouteAccess } from "./routes";

// What a route says about itself is what decides its guard, so a page is guarded
// by being listed as protected rather than by wiring one of its own.
export const Route = ({
    component: Component,
    access,
}: {
    component: ComponentType;
    access: RouteAccess;
}) => {
    if (access === "protected") {
        return (
            <ProtectedRoute>
                <Component />
            </ProtectedRoute>
        );
    }

    return <Component />;
};
