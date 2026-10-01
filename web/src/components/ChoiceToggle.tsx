import { SegmentedControl } from "@gamecrafters/base-ui/react";

interface ChoiceToggleProps<Value extends string> {
    // What is being chosen, as the choice is read out.
    label: string;
    choices: { value: Value; label: string }[];
    value: Value;
    onChange: (value: Value) => void;
}

// The reference's outlined toggle between two ways of doing one thing -- a path
// to a file or the text of it, say: a pill of buttons as tall and at least as
// wide as its own, the chosen one tinted. It is the design system's segmented
// control drawn that way, with neither its track nor its raised knob, and with
// each label at the weight the reference sets it rather than bolder when chosen.
export const ChoiceToggle = <Value extends string>({
    label,
    choices,
    value,
    onChange,
}: ChoiceToggleProps<Value>) => {
    return (
        <SegmentedControl
            aria-label={label}
            onChange={(index) => onChange(choices[index].value)}
            className="h-9 shrink-0 overflow-hidden rounded-full border border-[var(--border-color-default)] bg-transparent [&>li]:m-0 [&>li]:after:hidden"
        >
            {choices.map((choice) => (
                <SegmentedControl.Button
                    key={choice.value}
                    selected={choice.value === value}
                    className="min-w-16 rounded-none px-4 py-0 text-[14px] leading-5 font-medium tracking-normal text-[var(--foreground-color-default)] hover:bg-[var(--control-transparent-background-color-hover)] aria-pressed:bg-[var(--control-background-color-active)] [&_[data-component='SegmentedControl.Text']]:after:hidden [&>span]:rounded-none [&>span]:border-0 [&>span]:bg-transparent [&>span]:px-0"
                >
                    {choice.label}
                </SegmentedControl.Button>
            ))}
        </SegmentedControl>
    );
};
