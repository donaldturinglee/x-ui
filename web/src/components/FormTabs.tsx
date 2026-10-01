import { Tabs } from "@gamecrafters/base-ui/react";
import { useEffect, useRef, type ReactNode } from "react";

interface FormTabsProps {
    // What the tabs divide, as the list of them is read out.
    label: string;
    tabs: { value: string; label: string; panel: ReactNode }[];
    // Which tab is open, held by the dialog so that a save refused over a field
    // on another tab can bring that field back into view.
    tab: string;
    onTabChange: (tab: string) => void;
}

// The reference's tabs: the same height and width as its own, centred, and each
// in the plain colour of text with the open one underlined in it. A tab never
// narrows past its name, so where there is not the room for every one -- a page
// of them on a phone -- the row scrolls, as the reference's does, rather than
// writing one name over the next; and it is only centred while it fits, so its
// first tab is never pushed out of reach at the start.
const TAB =
    "h-12 min-w-[90px] shrink-0 rounded-none px-4 py-0 text-[14px] font-medium text-[var(--foreground-color-default)] aria-selected:border-[var(--foreground-color-default)]";

// A dialog's form split across tabs, as the reference splits the larger ones,
// straight under the dialog's title. The tabs that are not open are hidden
// rather than taken away, so what was typed on one is still there on the save.
export const FormTabs = ({ label, tabs, tab, onTabChange }: FormTabsProps) => {
    const listRef = useRef<HTMLDivElement>(null);

    // In a row that scrolls, the open tab is brought into view, as the
    // reference brings it, so a page opened on its last tab shows which one it
    // is. Only the row is scrolled, never the page or the dialog it sits in.
    useEffect(() => {
        const list = listRef.current;
        const open = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

        if (!list || !open) {
            return;
        }

        const row = list.getBoundingClientRect();
        const box = open.getBoundingClientRect();

        if (box.left < row.left) {
            list.scrollLeft -= row.left - box.left;
        } else if (box.right > row.right) {
            list.scrollLeft += box.right - row.right;
        }
    }, [tab]);

    return (
        <Tabs value={tab} onChange={onTabChange}>
            <Tabs.List
                ref={listRef}
                aria-label={label}
                className="justify-center-safe overflow-x-auto border-b-0"
            >
                {tabs.map(({ value, label: name }) => (
                    <Tabs.Tab key={value} value={value} className={TAB}>
                        {name}
                    </Tabs.Tab>
                ))}
            </Tabs.List>

            {tabs.map(({ value, panel }) => (
                <Tabs.Panel key={value} value={value}>
                    {panel}
                </Tabs.Panel>
            ))}
        </Tabs>
    );
};
