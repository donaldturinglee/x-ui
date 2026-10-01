import { Navigate } from "react-router";

import { settingsTabPath } from "@/features/settings/Settings";

// Where the subscription's settings used to be a page of their own. They are a
// tab of the settings page now, beside the panel's own, so a link or a bookmark
// to the old address is sent on to that tab.
export const Subscriptions = () => {
    return <Navigate to={settingsTabPath("subscription")} replace />;
};
