import { Navigate } from "react-router";

import { getRoutePath } from "@/router/routes";

// Where API tokens used to be minted. They are opened from the admins page now,
// where the reference keeps them, so a link or a bookmark to the old address is
// sent on there.
export const Tokens = () => {
    return <Navigate to={getRoutePath("admins")} replace />;
};
