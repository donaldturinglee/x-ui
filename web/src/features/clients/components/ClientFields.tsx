import { IconButton, ProgressBar, Text, Tooltip } from "@gamecrafters/base-ui/react";
import {
    ArrowCounterclockwiseRegular,
    ArrowDownloadRegular,
    ArrowUploadRegular,
    SelectAllOnRegular,
} from "@gamecrafters/base-ui-icons";
import { useId } from "react";
import {
    Controller,
    useWatch,
    type Control,
    type FieldErrors,
    type UseFormRegister,
    type UseFormSetValue,
} from "react-hook-form";

import { FilledMultiSelect, FilledSwitch, FilledTextInput } from "@/components/FilledField";
import { useInbounds } from "@/features/inbounds/api";
import { formatBytes } from "@/features/overview/api";

import {
    DEFAULT_RESET_DAYS,
    MAXIMUM_RESET_DAYS,
    MAXIMUM_VOLUME,
    quotaTone,
    usedBytes,
    usedFraction,
    useClientGroups,
    type Client,
    type ClientRequest,
} from "../api";

interface ClientFieldsProps {
    register: UseFormRegister<ClientRequest>;
    control: Control<ClientRequest>;
    errors: FieldErrors<ClientRequest>;
    setValue: UseFormSetValue<ClientRequest>;
    // The subscriber being amended, as last read, whose traffic is said under
    // the fields; none for a new one, who has spent nothing.
    client?: Client;
    onResetTraffic?: () => void;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// Which way traffic went, in the colours the reference gives it: what was sent
// up in the colour of something to watch, what came down in the colour of
// something fine. A line of its own rather than text in one, so the marks in it
// do not make the line taller than the reference's.
const Traffic = ({ up, down }: { up: number; down: number }) => {
    return (
        <span className="flex min-h-[24.8px] flex-wrap items-center gap-x-1">
            <span className="inline-flex items-center text-[var(--foreground-color-attention)]">
                <ArrowUploadRegular aria-hidden size={20} />
                <span className="sr-only">Up </span>
                {formatBytes(up)}
            </span>
            /
            <span className="inline-flex items-center text-[var(--foreground-color-success)]">
                <ArrowDownloadRegular aria-hidden size={20} />
                <span className="sr-only">Down </span>
                {formatBytes(down)}
            </span>
        </span>
    );
};

// The first of the subscriber's tabs, laid out as the reference lays it out:
// whether they may connect and their group, who they are, how much and how long
// they have, when their clock starts and whether their quota repeats, then --
// for one already written -- what they have spent, and the listeners they
// connect through across the foot.
//
// How long they have follows the two switches as the reference's does: a clock
// held until their first byte and not repeated runs for so many days from then,
// so it has no date of its own, and either switch asks for that many days.
export const ClientFields = ({
    register,
    control,
    errors,
    setValue,
    client,
    onResetTraffic,
}: ClientFieldsProps) => {
    const { data: inbounds } = useInbounds();
    const { data: groups } = useClientGroups();
    const nameId = useId();
    const groupId = useId();
    const groupsId = useId();
    const descriptionId = useId();
    const volumeId = useId();
    const expiryId = useId();
    const resetDaysId = useId();
    const inboundsId = useId();

    const [delayStart, autoReset, resetDays] = useWatch({
        control,
        name: ["delayStart", "autoReset", "resetDays"],
    });

    // Auto reset starts at 30 days, a held clock at one; keep any chosen period.
    const setClock = (changes: { delayStart?: boolean; autoReset?: boolean }) => {
        const next = { delayStart, autoReset, ...changes };

        if (changes.delayStart !== undefined) {
            setValue("delayStart", changes.delayStart);
        }
        if (changes.autoReset !== undefined) {
            setValue("autoReset", changes.autoReset);
        }

        const days = resetDays > 0 ? resetDays : next.autoReset ? DEFAULT_RESET_DAYS : 1;
        setValue("resetDays", next.delayStart || next.autoReset ? days : 0);

        // A held clock that is not repeated ends where it is started, so the
        // date it had is let go.
        if (next.delayStart && !next.autoReset) {
            setValue("expiry", "");
        }
    };

    const used = client ? usedBytes(client) : 0;
    const fraction = client ? usedFraction(client) : null;

    return (
        <div className="flex flex-col gap-2">
            <div className={ROW}>
                <Controller
                    control={control}
                    name="enable"
                    render={({ field }) => (
                        <FilledSwitch
                            label="Enabled"
                            className={FIELD}
                            checked={field.value}
                            onCheckedChange={field.onChange}
                        />
                    )}
                />
                {/* Typed rather than picked, with the groups already in use
                    offered as it is typed: a new group is only a new name. */}
                <FilledTextInput
                    id={groupId}
                    label="Group"
                    className={FIELD}
                    autoComplete="off"
                    list={groupsId}
                    validation={errors.group?.message}
                    {...register("group")}
                />
                <datalist id={groupsId}>
                    {groups?.map((group) => (
                        <option key={group} value={group} />
                    ))}
                </datalist>
            </div>

            <div className={ROW}>
                <FilledTextInput
                    id={nameId}
                    label="Name"
                    className={FIELD}
                    autoComplete="off"
                    spellCheck={false}
                    validation={errors.name?.message}
                    {...register("name")}
                />
                <FilledTextInput
                    id={descriptionId}
                    label="Description"
                    className={FIELD}
                    validation={errors.desc?.message}
                    {...register("desc")}
                />
            </div>

            <div className={ROW}>
                {/* Typed in the unit it is sold in; nothing is unlimited. */}
                <Controller
                    control={control}
                    name="volume"
                    render={({ field }) => (
                        <FilledTextInput
                            id={volumeId}
                            label="Volume (GiB)"
                            className={FIELD}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={MAXIMUM_VOLUME}
                            validation={errors.volume?.message}
                            ref={field.ref}
                            value={String(field.value)}
                            onChange={(event) => field.onChange(Number(event.target.value) || 0)}
                            onBlur={field.onBlur}
                        />
                    )}
                />
                {!(delayStart && !autoReset) && (
                    <FilledTextInput
                        id={expiryId}
                        label="Expiry"
                        className={FIELD}
                        type="date"
                        {...register("expiry")}
                    />
                )}
                {(autoReset || delayStart) && (
                    <Controller
                        control={control}
                        name="resetDays"
                        render={({ field }) => (
                            <FilledTextInput
                                id={resetDaysId}
                                label="Reset days"
                                className={FIELD}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                max={MAXIMUM_RESET_DAYS}
                                validation={errors.resetDays?.message}
                                ref={field.ref}
                                value={field.value ? String(field.value) : ""}
                                onChange={(event) =>
                                    field.onChange(Number(event.target.value) || 0)
                                }
                                onBlur={field.onBlur}
                            />
                        )}
                    />
                )}
            </div>

            <div className={ROW}>
                {/* A clock can only be held until a first byte that has not come:
                    one who has spent anything has started it already. */}
                <FilledSwitch
                    label="Delay start"
                    className={FIELD}
                    disabled={used > 0}
                    checked={delayStart}
                    onCheckedChange={(on) => setClock({ delayStart: on })}
                />
                <FilledSwitch
                    label="Auto reset"
                    className={FIELD}
                    checked={autoReset}
                    onCheckedChange={(on) => setClock({ autoReset: on })}
                />
            </div>

            {client && (
                <div className={ROW}>
                    <div className={`${FIELD} flex flex-col`}>
                        <div className="flex h-7 items-center justify-between">
                            <Text className="text-[16px] leading-6">
                                Usage: {formatBytes(used)}
                                {fraction !== null && fraction > 0 && (
                                    <sup className="ms-0.5">({Math.round(fraction * 100)}%)</sup>
                                )}
                            </Text>
                            {/* Handing the quota back is asked about first, and
                                done by the API rather than on the save: the
                                counters are the API's to write. */}
                            <Tooltip text="Reset" direction="n">
                                <IconButton
                                    icon={<ArrowCounterclockwiseRegular size={22} />}
                                    aria-label="Reset traffic"
                                    variant="invisible"
                                    className="size-7 min-w-0 rounded-full p-0 text-[var(--foreground-color-default)]"
                                    onClick={onResetTraffic}
                                />
                            </Tooltip>
                        </div>
                        {fraction !== null && (
                            <ProgressBar
                                progress={fraction * 100}
                                variant={quotaTone(client)}
                                aria-label={`${client.name} quota used`}
                                className="h-1 rounded-none"
                            />
                        )}
                    </div>
                    <div className={`${FIELD} flex h-7 items-center text-[16px] leading-6`}>
                        <Traffic up={client.up} down={client.down} />
                    </div>
                </div>
            )}

            {client && autoReset && (
                <div className={ROW}>
                    <div className={`${FIELD} text-[16px] leading-6`}>
                        <div className="text-[var(--foreground-color-muted)]">Next reset</div>
                        <div>
                            {client.nextReset
                                ? new Date(client.nextReset * 1000).toLocaleString()
                                : "—"}
                        </div>
                    </div>
                    <div className={`${FIELD} text-[16px] leading-6`}>
                        <div className="text-[var(--foreground-color-muted)]">Total usage</div>
                        <Traffic
                            up={client.totalUp + client.up}
                            down={client.totalDown + client.down}
                        />
                    </div>
                </div>
            )}

            {/* The subscription is built from these, so a subscriber with none
                has a link that resolves to nothing. It is a field rather than
                something set elsewhere because the API takes what is sent as the
                whole set: a form that did not carry it would post an empty one
                and cut them off from every listener. */}
            <Controller
                control={control}
                name="inbounds"
                render={({ field }) => (
                    <FilledMultiSelect
                        id={inboundsId}
                        label="Inbound tags"
                        options={(inbounds ?? []).map((inbound) => ({
                            value: String(inbound.id),
                            label: inbound.tag,
                        }))}
                        value={field.value.map(String)}
                        onChange={(ids) => field.onChange(ids.map(Number))}
                        append={
                            <Tooltip text="All" direction="n">
                                <IconButton
                                    icon={<SelectAllOnRegular size={24} />}
                                    aria-label="Every inbound"
                                    variant="invisible"
                                    className="size-6 min-w-0 p-0 text-[var(--foreground-color-muted)]"
                                    onClick={() =>
                                        field.onChange(
                                            (inbounds ?? []).map((inbound) => inbound.id),
                                        )
                                    }
                                />
                            </Tooltip>
                        }
                    />
                )}
            />
        </div>
    );
};
