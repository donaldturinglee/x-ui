import { Card } from "@gamecrafters/base-ui/react";

import { useSearchParams } from "react-router";

import { FormTabs } from "@/components/FormTabs";
import { getRoutePath } from "@/router/routes";

import { ExperimentalTab } from "./components/ExperimentalTab";
import { HttpClientsTab } from "./components/HttpClientsTab";
import { LogsTab } from "./components/LogsTab";
import { NtpTab } from "./components/NtpTab";
import { PanelTab } from "./components/PanelTab";
import { SingBoxTab } from "./components/SingBoxTab";
import { SubscriptionTab } from "./components/SubscriptionTab";
import { TelegramTab } from "./components/TelegramTab";
import { TwoFactorTab } from "./components/TwoFactorTab";

// The tabs, in the order the page offers them, each held in the address by its
// value so a reload or a link lands on it.
const TABS = [
    { value: "panel", label: "Panel", panel: <PanelTab /> },
    { value: "subscription", label: "Subscription", panel: <SubscriptionTab /> },
    { value: "two-factor", label: "Two-factor authentication", panel: <TwoFactorTab /> },
    { value: "telegram", label: "Telegram Bot", panel: <TelegramTab /> },
    { value: "sing-box", label: "Sing Box", panel: <SingBoxTab /> },
    { value: "ntp", label: "NTP", panel: <NtpTab /> },
    { value: "http-clients", label: "HTTP Clients", panel: <HttpClientsTab /> },
    { value: "experimental", label: "Experimental", panel: <ExperimentalTab /> },
    { value: "logs", label: "Logs", panel: <LogsTab /> },
];

export type SettingsTab =
    | "panel"
    | "subscription"
    | "two-factor"
    | "telegram"
    | "sing-box"
    | "ntp"
    | "http-clients"
    | "experimental"
    | "logs";

// Where one tab of the page is reached, for a page that leads to it.
export const settingsTabPath = (tab: SettingsTab) =>
    `${getRoutePath("generalSettings")}?tab=${tab}`;

// The panel's settings, laid out as the reference lays out its settings page:
// one card with its tabs centred across the top and the open one's options
// under them. Each tab acts on its own -- the subscription's and the Telegram
// bot's are saved and put back apart, the panel's own and the generated
// configuration are shown, two-factor authentication is the signed-in
// operator's, and the core's clock, HTTP clients, experimental interfaces and
// log are each saved into the document the nodes are configured from. Each has
// its buttons along the foot of the card rather than one Save for all of
// them, as the reference's has.
export const Settings = () => {
    const [params, setParams] = useSearchParams();
    const asked = params.get("tab");
    const tab = TABS.some(({ value }) => value === asked) ? asked! : TABS[0].value;

    return (
        <Card
            padding="none"
            className="gap-0 rounded-[4px] border-0 bg-[var(--background-color-default)] shadow-[var(--shadow-resting-medium)]"
        >
            <FormTabs
                label="Settings"
                tabs={TABS}
                tab={tab}
                onTabChange={(next) => setParams({ tab: next }, { replace: true })}
            />
        </Card>
    );
};
