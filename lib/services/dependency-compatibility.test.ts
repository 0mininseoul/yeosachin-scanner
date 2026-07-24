import { createRequire } from "node:module";

import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

const runtimeRequire = createRequire(import.meta.url);

type FlatPlugin = NonNullable<Linter.Config["plugins"]>[string];

const reactPlugin = runtimeRequire("eslint-plugin-react") as FlatPlugin;
const importPlugin = runtimeRequire("eslint-plugin-import") as FlatPlugin;
const jsxA11yPlugin = runtimeRequire("eslint-plugin-jsx-a11y") as FlatPlugin;

const languageOptions = {
  parserOptions: {
    ecmaFeatures: { jsx: true },
    ecmaVersion: "latest" as const,
    sourceType: "module" as const,
  },
};

describe("ESLint transitive minimatch compatibility", () => {
  it("keeps eslint-plugin-react custom component patterns callable", () => {
    const messages = new Linter({ configType: "flat" }).verify(
      "const CustomCard = () => <div />; const App = () => <CustomCard dangerouslySetInnerHTML={{ __html: 'x' }} />;",
      [
        {
          files: ["**/*.jsx"],
          languageOptions,
          plugins: { react: reactPlugin },
          rules: {
            "react/no-danger": [
              "error",
              { customComponentNames: ["Custom{Card,Panel}"] },
            ],
          },
        },
      ],
      { filename: "compat.jsx" },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("react/no-danger");
  });

  it("keeps eslint-plugin-import minimatch helpers callable", () => {
    const messages = new Linter({ configType: "flat" }).verify(
      "import value from './allowed/value.js'; console.log(value);",
      [
        {
          files: ["**/*.js"],
          languageOptions,
          plugins: { import: importPlugin },
          rules: {
            "import/no-internal-modules": [
              "error",
              { allow: ["**/{allowed,safe}/**"] },
            ],
          },
        },
      ],
      { filename: "src/compat.js" },
    );

    expect(messages).toEqual([]);
  });

  it("keeps eslint-plugin-jsx-a11y component patterns callable", () => {
    const messages = new Linter({ configType: "flat" }).verify(
      "const Form = () => <label>Pick<CustomControl /></label>;",
      [
        {
          files: ["**/*.jsx"],
          languageOptions,
          plugins: { "jsx-a11y": jsxA11yPlugin },
          rules: {
            "jsx-a11y/label-has-associated-control": [
              "error",
              {
                assert: "nesting",
                controlComponents: ["Custom{Control,Button}"],
              },
            ],
          },
        },
      ],
      { filename: "compat.jsx" },
    );

    expect(messages).toEqual([]);
  });
});
