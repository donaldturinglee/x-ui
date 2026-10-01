import { Card, Heading, IconButton, Tooltip } from "@gamecrafters/base-ui/react";
import type { IconProps } from "@gamecrafters/base-ui-icons";
import type { ComponentType, ReactNode } from "react";

interface TileProps {
    title: string;
    // Stands beside the title: what the tile can be asked to do, or what it has
    // to say that will not fit inside it.
    action?: ReactNode;
    children: ReactNode;
}

// One reading, in a box of a fixed height so that a row of tiles is a row rather
// than a staircase. The title names what is being read and the body draws it;
// what the body holds is each tile's own business.
export const Tile = ({ title, action, children }: TileProps) => {
    return (
        <Card
            padding="none"
            className="h-[210px] gap-0 rounded-[8px] bg-transparent shadow-[var(--shadow-resting-medium)]"
        >
            <div className="flex items-center justify-center px-4 py-2">
                <Heading as="h2" className="truncate text-[22px] leading-7 font-normal">
                    {title}
                </Heading>
                {action}
            </div>

            {/* Centred rather than ranged left, because what stands here is a
                figure or a dial rather than a sentence. */}
            <div className="px-4 text-center text-[14px] leading-5 tracking-[0.25px]">
                {children}
            </div>
        </Card>
    );
};

interface TileActionProps {
    icon: ComponentType<IconProps>;
    // What the button is called where it is read out rather than pointed at.
    label: string;
    // What the tooltip says. On a tile whose action only reports something, this
    // is the whole of what the mark is for.
    description: string;
    loading?: boolean;
    onClick?: () => void;
}

// The mark beside a tile's title. It is a button in every case, including where
// it only carries a tooltip: a tooltip is shown on hover or focus, so anything
// wearing one has to be reachable from the keyboard as well as the pointer.
export const TileAction = ({
    icon: Icon,
    label,
    description,
    loading,
    onClick,
}: TileActionProps) => {
    return (
        <Tooltip text={description}>
            <IconButton
                icon={<Icon size={18} />}
                aria-label={label}
                variant="invisible"
                loading={loading}
                className="ms-[10px] size-6 rounded-full text-[var(--foreground-color-accent)]"
                onClick={onClick}
            />
        </Tooltip>
    );
};
