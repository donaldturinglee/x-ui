import type { ColorModeWithAuto } from "@gamecrafters/base-ui/react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type ThemeState = {
    colorMode: ColorModeWithAuto;
    setColorMode: (colorMode: ColorModeWithAuto) => void;
};

export const useThemeStore = create<ThemeState>()(
    persist(
        (set) => ({
            colorMode: "auto",
            setColorMode: (colorMode) => set({ colorMode }),
        }),
        { name: "x-ui.theme" },
    ),
);
