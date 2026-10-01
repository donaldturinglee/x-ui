import { ActionList, ActionMenu, IconButton } from "@gamecrafters/base-ui/react";
import type { ColorModeWithAuto } from "@gamecrafters/base-ui/react";
import {
    DarkThemeRegular,
    LaptopRegular,
    WeatherMoonRegular,
    WeatherSunnyRegular,
    type IconProps,
} from "@gamecrafters/base-ui-icons";
import type { ComponentType } from "react";

import { useThemeStore } from "@/stores/theme";

const modes: { value: ColorModeWithAuto; label: string; Icon: ComponentType<IconProps> }[] = [
    { value: "light", label: "Light", Icon: WeatherSunnyRegular },
    { value: "dark", label: "Dark", Icon: WeatherMoonRegular },
    { value: "auto", label: "Match system", Icon: LaptopRegular },
];

// The choice is kept per browser rather than per operator: it is about the room
// the screen is in, not about the account, and a panel left open on a wall is
// not signed in as anybody in particular.
//
interface ThemeControlProps {
    // How the button is drawn where it stands, beyond its size and shape.
    className?: string;
}

// It is a button rather than a field, so it can stand at the end of the app bar
// and below the sign-in form alike, and a menu of three rather than a toggle, so
// following the system stays one of the choices instead of a state that is lost
// the first time the button is pressed.
export const ThemeControl = ({ className }: ThemeControlProps) => {
    const colorMode = useThemeStore((state) => state.colorMode);
    const setColorMode = useThemeStore((state) => state.setColorMode);

    return (
        <ActionMenu>
            <ActionMenu.Anchor>
                <IconButton
                    icon={<DarkThemeRegular size={24} />}
                    aria-label="Colour theme"
                    variant="invisible"
                    className={`size-12 rounded-full text-[var(--foreground-color-default)] ${className ?? ""}`}
                />
            </ActionMenu.Anchor>

            <ActionMenu.Overlay align="end">
                <ActionList selectionVariant="single">
                    {modes.map(({ value, label, Icon }) => (
                        <ActionList.Item
                            key={value}
                            selected={colorMode === value}
                            onSelect={() => setColorMode(value)}
                        >
                            <ActionList.LeadingVisual>
                                <Icon />
                            </ActionList.LeadingVisual>
                            {label}
                        </ActionList.Item>
                    ))}
                </ActionList>
            </ActionMenu.Overlay>
        </ActionMenu>
    );
};
