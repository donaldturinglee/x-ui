// The tabs of the settings page share the card they are drawn in, and the way a
// tab lays out its fields and its buttons: three fields a row on a wide screen,
// two on a tablet and one on a phone, as the reference lays out its settings,
// and whatever acts on the tab along the foot of the card under a line, Save
// last, where a dialog keeps it.
export const FIELDS = "grid grid-cols-1 gap-2 min-[600px]:grid-cols-2 min-[840px]:grid-cols-3";

export const FOOTER =
    "flex min-h-[52px] flex-wrap items-center justify-end gap-2 border-t border-[var(--border-color-default)] p-2";

// Putting options back is outlined in the colour of something that cannot be
// undone; saving is the one filled in.
export const RESTORE_BUTTON =
    "h-9 rounded-[4px] border-[var(--border-color-attention-emphasis)] bg-transparent px-4 text-[14px] text-[var(--foreground-color-attention)]";

export const SAVE_BUTTON =
    "h-9 min-w-16 rounded-[4px] px-4 text-[14px] shadow-[var(--shadow-resting-small)]";

// A button that acts beside the save rather than on what is saved.
export const PLAIN_BUTTON = "h-9 rounded-[4px] bg-transparent px-4 text-[14px]";

// The small muted line that heads a group of fields inside a tab.
export const GROUP_HEADING =
    "mt-4 mb-2 px-4 text-[14px] leading-5 font-normal tracking-[0.25px] text-[var(--foreground-color-muted)]";
