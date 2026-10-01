import { Navigate } from "react-router";

import { getRoutePath } from "@/router/routes";

// /general is a section rather than a page, and /settings is where the settings
// used to be before they were kept under General. Both lead to the settings
// page, so a link or an old bookmark still lands somewhere, without the section
// and a page in it sharing a URL -- which had both of them claiming to be the
// current page at once.
export const GeneralIndex = () => {
    return <Navigate to={getRoutePath("generalSettings")} replace />;
};
