import { IconButton } from "@gamecrafters/base-ui/react";
import { AddRegular, DeleteRegular } from "@gamecrafters/base-ui-icons";
import { useId, useState } from "react";

import { FilledTextInput } from "@/components/FilledField";
import { FormSection } from "@/components/FormSection";

import { hostsOf, withHosts, type Host } from "../api";

interface PredefinedHostsProps {
    // The server's `predefined` option, which the block reads its rows off and
    // hands back whole with them changed.
    value: unknown;
    onChange: (predefined: Record<string, string[]> | undefined) => void;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up; a half one a half from a tablet up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";
const HALF = "col-span-12 min-[600px]:col-span-6";

// The reference's block of the names a hosts server answers for itself: a row
// to a name, with its addresses a comma apart and the button that takes the row
// away beside them, and the one that adds a row at the head of the block.
//
// The rows are held here while they are typed, so two that name the same host
// -- one just added, before it is named, say -- stay two rows rather than one
// swallowing the other. A new one starts empty rather than as the reference's
// localhost, which is a name the node answers for already.
export const PredefinedHosts = ({ value, onChange }: PredefinedHostsProps) => {
    const fieldIds = useId();
    const [hosts, setHosts] = useState(() => hostsOf(value));

    const change = (next: Host[]) => {
        setHosts(next);
        onChange(withHosts(next));
    };
    const setHost = (index: number, host: Host) =>
        change(hosts.map((current, at) => (at === index ? host : current)));

    return (
        <FormSection
            title="Predefined"
            hasFlushTitle
            titleAction={
                <IconButton
                    icon={<AddRegular size={16} />}
                    aria-label="Add a predefined host"
                    variant="primary"
                    className="inline-flex h-6 w-[42px] min-w-0 rounded-full p-0 align-middle shadow-[var(--shadow-resting-small)]"
                    onClick={() => change([...hosts, { name: "", addresses: "" }])}
                />
            }
        >
            <div className="flex flex-col gap-2">
                {hosts.map((host, index) => (
                    <div key={index} className={ROW}>
                        <FilledTextInput
                            id={`${fieldIds}-name-${index}`}
                            label="Domain"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            value={host.name}
                            onChange={(event) =>
                                setHost(index, { ...host, name: event.target.value })
                            }
                        />
                        {/* The button stands outside the field, as the
                            reference's does, and the field gives it the room. */}
                        <div className={`${HALF} flex items-center gap-4`}>
                            <FilledTextInput
                                id={`${fieldIds}-addresses-${index}`}
                                label="Addresses (comma separated)"
                                className="min-w-0 grow"
                                autoComplete="off"
                                spellCheck={false}
                                value={host.addresses}
                                onChange={(event) =>
                                    setHost(index, { ...host, addresses: event.target.value })
                                }
                            />
                            <IconButton
                                icon={<DeleteRegular size={20} />}
                                aria-label={`Delete ${host.name || `host ${index + 1}`}`}
                                variant="invisible"
                                className="size-6 min-w-0 shrink-0 p-0 text-[var(--foreground-color-danger)]"
                                onClick={() => change(hosts.filter((_, at) => at !== index))}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </FormSection>
    );
};
