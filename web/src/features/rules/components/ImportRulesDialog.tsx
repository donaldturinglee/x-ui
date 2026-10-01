import {
    Checkbox,
    Dialog,
    FormControl,
    Radio,
    RadioGroup,
    Stack,
    Text,
    Textarea,
} from "@gamecrafters/base-ui/react";
import { useId, useState, type RefObject } from "react";

import { importRoute, readRouteBlock, type Route } from "../api";

interface ImportRulesDialogProps {
    // What the page holds, which the imported rules go after or in place of.
    route: Route;
    onImport: (route: Route) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// Rules and rule sets taken from another configuration, pasted in whole or as
// its route section alone, the way the reference imports them. They go into the
// page like any other change, so nothing is written until Save.
//
// The reference also reads a file or fetches an address. A file's contents can
// be pasted, and an address a browser fetches is refused by most hosts that are
// not the panel's own, so neither is offered.
export const ImportRulesDialog = ({
    route,
    onImport,
    onClose,
    returnFocusRef,
}: ImportRulesDialogProps) => {
    const documentId = useId();
    const takeFinalId = useId();
    const replaceId = useId();
    const mergeId = useId();

    const hasOwn = (route.rules?.length ?? 0) > 0 || (route.rule_set?.length ?? 0) > 0;
    const [pasted, setPasted] = useState("");
    const [mode, setMode] = useState<"merge" | "replace">(hasOwn ? "merge" : "replace");
    const [takeFinal, setTakeFinal] = useState(false);

    // Read as it is typed, so what would be taken is said before it is.
    const block = readRouteBlock(pasted);
    const taken = new Set((route.rule_set ?? []).map((ruleSet) => ruleSet.tag));
    const skipped =
        block && mode === "merge"
            ? block.rule_set.filter((ruleSet) => taken.has(ruleSet.tag)).length
            : 0;

    return (
        <Dialog
            title="Import rules"
            subtitle="Kept on the page until it is saved."
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
            footerButtons={[
                { content: "Cancel", onClick: onClose },
                {
                    content: "Import",
                    buttonType: "primary",
                    disabled: !block,
                    onClick: () => {
                        if (block) {
                            onImport(importRoute(route, block, mode, takeFinal));
                        }
                    },
                },
            ]}
        >
            <Stack gap="normal">
                <FormControl id={documentId}>
                    <FormControl.Label>Configuration</FormControl.Label>
                    <Textarea
                        id={documentId}
                        block
                        rows={12}
                        spellCheck={false}
                        className="font-mono"
                        validationStatus={pasted.trim() && !block ? "error" : undefined}
                        value={pasted}
                        onChange={(event) => setPasted(event.target.value)}
                    />
                    <FormControl.Caption>
                        A whole configuration or its route section, as JSON. Its rules and rule sets
                        are what is taken.
                    </FormControl.Caption>
                    {pasted.trim() && !block && (
                        <FormControl.Validation variant="error">
                            Nothing to take: this is not a JSON object with rules or rule_set in it.
                        </FormControl.Validation>
                    )}
                </FormControl>

                {block && (
                    <Text as="p" className="m-0">
                        {block.rules.length === 1 ? "1 rule" : `${block.rules.length} rules`} and{" "}
                        {block.rule_set.length === 1
                            ? "1 rule set"
                            : `${block.rule_set.length} rule sets`}
                        .
                        {skipped > 0 &&
                            ` ${skipped === 1 ? "One rule set is" : `${skipped} rule sets are`} left out, its tag being taken already.`}
                    </Text>
                )}

                {block && hasOwn && (
                    <RadioGroup
                        name="mode"
                        onChange={(value) => setMode(value === "replace" ? "replace" : "merge")}
                    >
                        <RadioGroup.Label>The rules already here</RadioGroup.Label>
                        <FormControl id={mergeId}>
                            <Radio id={mergeId} value="merge" checked={mode === "merge"} />
                            <FormControl.Label>Keep them, and add these after</FormControl.Label>
                        </FormControl>
                        <FormControl id={replaceId}>
                            <Radio id={replaceId} value="replace" checked={mode === "replace"} />
                            <FormControl.Label>Replace them with these</FormControl.Label>
                        </FormControl>
                    </RadioGroup>
                )}

                {block?.final && (
                    <FormControl id={takeFinalId}>
                        <FormControl.Label>
                            Send what no rule matches to {block.final}, as it does
                        </FormControl.Label>
                        <Checkbox
                            id={takeFinalId}
                            checked={takeFinal}
                            onChange={(event) => setTakeFinal(event.target.checked)}
                        />
                    </FormControl>
                )}
            </Stack>
        </Dialog>
    );
};
