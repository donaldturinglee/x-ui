import { Navigate } from "react-router";

import { getRoutePath } from "@/router/routes";

// Where an operator's own credentials used to be changed. They are changed from
// their card on the admins page now, where the reference keeps them, so a link
// or a bookmark to the old address is sent on there.
export const Account = () => {
    return <Navigate to={getRoutePath("admins")} replace />;
};
