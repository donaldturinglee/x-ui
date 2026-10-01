import type { ReactNode } from "react";

import { toUnits, useSystemStatus, type Usage } from "../api";
import { tileTitle, type GaugeTileId } from "../tiles";

import { Tile } from "./Tile";

interface Reading {
    percent: number;
    // What is written inside the dial: a percentage, or a pair with the unit
    // each end is in worn as a suffix.
    figure: ReactNode;
}

// A reading the host could not take is left out of the status rather than sent
// as zero, because zero disk usage and unknown disk usage look identical on a
// dial and mean opposite things. Swap arrives the same way on a host that has
// none: a pair totalling nothing.
const readUsage = (usage: Usage | undefined): Reading | null => {
    if (!usage || usage.total === 0) {
        return null;
    }

    const current = toUnits(usage.current);
    const total = toUnits(usage.total);

    return {
        percent: Math.ceil((usage.current / usage.total) * 100),
        figure: (
            <>
                {current.value}
                {/* The unit is written once where both ends are in it, so the
                    pair reads as 5/116GB rather than 5GB/116GB. */}
                {current.unit !== total.unit && <sup className="text-[16px]">{current.unit}</sup>}/
                {total.value}
                <sup className="text-[16px]">{total.unit}</sup>
            </>
        ),
    };
};

const readPercent = (percent: number | undefined): Reading | null => {
    if (percent === undefined) {
        return null;
    }

    return { percent, figure: `${Math.ceil(percent)}%` };
};

// Blue until it is worth looking at, amber while it is filling and red once
// there is nothing much left, so a wall of dials can be read at a glance
// without any of them being counted.
const fillColor = (percent: number) => {
    if (percent > 90) {
        return "var(--background-color-danger-emphasis)";
    }

    if (percent > 70) {
        return "var(--background-color-attention-emphasis)";
    }

    return "var(--background-color-accent-emphasis)";
};

// How much of one thing is gone, drawn as a half-dial: an arc, a fill turned
// over it as far as the reading goes, and a disc laid on top that leaves the
// arc showing at the edges and the figure standing in the middle.
export const GaugeTile = ({ id }: { id: GaugeTileId }) => {
    const { data: status } = useSystemStatus();

    const reading = !status
        ? null
        : id === "g-cpu"
          ? readPercent(status.cpuPercent)
          : readUsage(id === "g-mem" ? status.memory : id === "g-dsk" ? status.disk : status.swap);

    return (
        <Tile title={tileTitle(id)}>
            <div className="mx-auto w-full max-w-[250px]">
                {/* The box is as tall as half its own width, so the dial keeps
                    its shape at whatever width the tile leaves it. */}
                <div className="relative h-0 w-full overflow-hidden rounded-t-[100%_200%] bg-[var(--background-color-neutral-muted)] pb-[50%]">
                    <div
                        className="absolute top-full left-0 h-full w-full origin-top transition-transform duration-200 ease-out"
                        style={{
                            // Half a turn is the whole dial, so a percentage is
                            // half as far round as it reads.
                            transform: `rotate(${(reading?.percent ?? 0) / 200}turn)`,
                            backgroundColor: fillColor(reading?.percent ?? 0),
                        }}
                    />

                    <div className="absolute top-[25%] left-1/2 box-border flex h-[150%] w-[75%] -translate-x-1/2 items-center justify-center rounded-full bg-[var(--background-color-inset)] pb-[25%] text-[32px] font-bold">
                        <span>{reading?.figure ?? "—"}</span>
                    </div>
                </div>
            </div>
        </Tile>
    );
};
