import eslint from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import prettier from "eslint-plugin-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["build", "playwright-report", "test-results", "blob-report"],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    reactHooks.configs.flat["recommended-latest"],
    reactRefresh.configs.vite,
    prettierConfig,
    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            ecmaVersion: 2023,
            globals: globals.browser,
        },
        plugins: {
            prettier: prettier,
        },
        rules: {
            // Require the use of === and !== (no implicit type conversions)
            eqeqeq: ["error", "always"],
            // Allow intentionally unused bindings when prefixed with an underscore
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            // Enable Prettier as a lint rule
            "prettier/prettier": "error",
        },
    },
    {
        // Route modules sit at the root of the router and of each feature, and
        // pair their component with the loader that belongs to it, which fast
        // refresh cannot follow on its own. Components under a feature's
        // `components` directory are held to the rule as usual.
        files: ["src/router/**/*.tsx", "src/features/*/*.tsx"],
        rules: {
            "react-refresh/only-export-components": "off",
        },
    },
    {
        files: ["vite.config.ts", "tests/**/*.{ts,tsx}"],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            "react-refresh/only-export-components": "off",
        },
    },
    {
        // The end to end suite drives a browser from Node rather than rendering
        // anything, and a Playwright fixture hands its value to a callback that
        // is named `use` by convention, which reads to the hooks rule as a hook
        // called outside a component.
        files: ["playwright.config.ts", "e2e/**/*.ts"],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            "react-hooks/rules-of-hooks": "off",
            "react-refresh/only-export-components": "off",
        },
    },
);
