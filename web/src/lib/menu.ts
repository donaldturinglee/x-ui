import { useRef, useState, type KeyboardEvent } from "react";

// A menu that stands inside a dialog. The design system's menu and dialog both
// listen for Escape on the page as a whole, so the dialog would close along with
// the menu, and everything typed into it with it. While the menu is open the key
// is kept from reaching either, and the menu is put away here instead, handing
// focus back to its button as it would itself.
//
// The menu is held open by `isOpen` and set by `setIsOpen`, its button is
// `anchorRef`, and `onKeyDown` goes on an element around the two: the menu's
// keys reach it through React's tree even though the menu is drawn elsewhere.
export const useMenuInDialog = () => {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [isOpen, setIsOpen] = useState(false);

    const onKeyDown = (event: KeyboardEvent) => {
        if (isOpen && event.key === "Escape") {
            event.stopPropagation();
            setIsOpen(false);
            anchorRef.current?.focus();
        }
    };

    return { anchorRef, isOpen, setIsOpen, onKeyDown };
};
