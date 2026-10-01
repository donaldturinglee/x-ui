import { Dialog, Heading, Stack, Switch } from "@gamecrafters/base-ui/react";
import type { RefObject } from "react";

import { useTilesStore } from "@/stores/tiles";

import { TILE_GROUPS, type TileId } from "../tiles";

interface TilesDialogProps {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// Which readings the overview is showing. Every tile costs the same poll, so
// this is about what an operator wants in front of them rather than about what
// the panel can afford to ask for -- a host with no swap and a panel nobody is
// watching the network of are both worth a page that says so by leaving them
// out.
export const TilesDialog = ({ onClose, returnFocusRef }: TilesDialogProps) => {
    const tiles = useTilesStore((state) => state.tiles);
    const setTiles = useTilesStore((state) => state.setTiles);

    const picked = new Set(tiles);

    const toggle = (id: TileId, on: boolean) => {
        const next = new Set(picked);

        if (on) {
            next.add(id);
        } else {
            next.delete(id);
        }

        setTiles([...next]);
    };

    return (
        <Dialog title="Tiles" onClose={onClose} returnFocusRef={returnFocusRef} width={800}>
            <Stack gap="normal">
                {TILE_GROUPS.map((group) => (
                    <Stack key={group.title} gap="condensed">
                        {/* The group names what the tiles under it are drawn as,
                            which is the choice being made here: the same figure
                            is offered as a dial and as a line. */}
                        <Heading
                            as="h3"
                            className="border-b border-[var(--border-color-default)] pb-1 text-center text-[14px] leading-5 font-normal text-[var(--foreground-color-muted)]"
                        >
                            {group.title}
                        </Heading>

                        <div className="grid grid-cols-1 gap-2 min-[840px]:grid-cols-2 min-[1145px]:grid-cols-4">
                            {group.tiles.map((tile) => (
                                <Switch
                                    key={tile.id}
                                    checked={picked.has(tile.id)}
                                    onCheckedChange={(checked) => toggle(tile.id, checked)}
                                >
                                    <Switch.Control>
                                        <Switch.Thumb />
                                    </Switch.Control>
                                    <Switch.Label>{tile.title}</Switch.Label>
                                    <Switch.HiddenInput />
                                </Switch>
                            ))}
                        </div>
                    </Stack>
                ))}
            </Stack>
        </Dialog>
    );
};
