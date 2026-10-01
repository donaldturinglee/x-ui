import type { ComponentProps } from "react";

import { FormTabs } from "@/components/FormTabs";

import { ClientCredentials } from "./ClientCredentials";
import { ClientFields } from "./ClientFields";
import { ClientLinksPanel } from "./ClientLinksPanel";

type ClientTabsProps = ComponentProps<typeof ClientFields> & {
    tab: string;
    onTabChange: (tab: string) => void;
};

// What a subscriber holds, split as the reference splits it: who they are and
// what they have, the credentials they authenticate with, and the links they
// are handed.
//
// The links are the one tab a new subscriber goes without. The API builds them
// from a saved subscriber's listeners, so until the save there is nothing for
// the tab to hold, and it is left out rather than shown empty.
export const ClientTabs = ({ tab, onTabChange, ...fields }: ClientTabsProps) => {
    const { client } = fields;

    return (
        <FormTabs
            label="Subscriber"
            tab={tab}
            onTabChange={onTabChange}
            tabs={[
                { value: "basics", label: "Basics", panel: <ClientFields {...fields} /> },
                {
                    value: "config",
                    label: "Config",
                    panel: (
                        <ClientCredentials control={fields.control} setValue={fields.setValue} />
                    ),
                },
                ...(client
                    ? [
                          {
                              value: "links",
                              label: "Links",
                              panel: <ClientLinksPanel client={client} />,
                          },
                      ]
                    : []),
            ]}
        />
    );
};
