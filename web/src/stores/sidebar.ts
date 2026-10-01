import { create } from "zustand";
import { persist } from "zustand/middleware";

type SidebarState = {
    isExpanded: boolean;
    expand: () => void;
    collapse: () => void;
    // The groups of pages folded away under their heading, by name.
    foldedGroups: string[];
    toggleGroup: (group: string) => void;
};

// Whether the rail is expanded to its full width, with the page moved along to
// make room for it, or collapsed to its icons -- which the app bar's button alone
// decides -- and which of its groups are folded. It is kept in the browser, as
// the theme is: it is about the screen the panel is on, not the account signed
// in to it.
export const useSidebarStore = create<SidebarState>()(
    persist(
        (set) => ({
            isExpanded: false,
            expand: () => set({ isExpanded: true }),
            collapse: () => set({ isExpanded: false }),
            foldedGroups: ["General"],
            toggleGroup: (group) =>
                set(({ foldedGroups }) => ({
                    foldedGroups: foldedGroups.includes(group)
                        ? foldedGroups.filter((folded) => folded !== group)
                        : [...foldedGroups, group],
                })),
        }),
        {
            name: "x-ui.sidebar",
            version: 1,
            // The old default left General open. Fold it once for existing
            // browsers, then keep whichever state the operator chooses.
            migrate: (persistedState) => ({
                ...(persistedState as SidebarState),
                foldedGroups: ["General"],
            }),
        },
    ),
);
