import { Link } from "@gamecrafters/base-ui/react";
import { InfoRegular } from "@gamecrafters/base-ui-icons";

interface DocLinkProps {
    href: string;
    // What it documents, which is what it is read out as.
    label: string;
    className?: string;
}

// The small mark that leads to the proxy core's own documentation, opened beside
// the panel rather than in place of it. It is sized to the text it stands in, as
// the reference's is, and centred in a box exactly as tall as the line, so a
// heading with one is no taller than a heading without.
export const DocLink = ({ href, label, className }: DocLinkProps) => {
    return (
        <Link
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`${label} documentation`}
            className={`inline-flex h-[1lh] items-center align-top text-[var(--foreground-color-accent)] ${className ?? ""}`}
        >
            <InfoRegular aria-hidden className="size-[1.25em]" />
        </Link>
    );
};
