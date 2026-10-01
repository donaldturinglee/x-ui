import { Heading } from "@gamecrafters/base-ui/react";
import type { ReactNode } from "react";

interface SectionTitleProps {
    id?: string;
    // The level it stands at: a section of the page, or of a panel on it.
    as?: "h2" | "h3";
    children: ReactNode;
}

// A heading between the sections of a page, the way the reference heads them:
// small and quiet, centred over a line that runs the width of the page.
export const SectionTitle = ({ id, as = "h2", children }: SectionTitleProps) => {
    return (
        <Heading
            as={as}
            id={id}
            className="min-h-5 border-b border-[var(--border-color-emphasis)] px-4 text-center text-[14px] leading-[21px] font-normal tracking-[0.25px] text-[var(--foreground-color-muted)]"
        >
            {children}
        </Heading>
    );
};
