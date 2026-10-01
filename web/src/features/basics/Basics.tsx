import { Navigate } from "react-router";

import { settingsTabPath } from "@/features/settings/Settings";

// The old Basics address leads to the first of its two settings tabs, so
// existing bookmarks still reach the node's clock and HTTP client settings.
export const Basics = () => <Navigate to={settingsTabPath("ntp")} replace />;
