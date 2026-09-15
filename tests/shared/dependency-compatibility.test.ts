import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

const runtimeRequire = createRequire(import.meta.url);

function readPackageVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  }).version;
}

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
  it("keeps each installed minimatch major on a compatible brace-expansion release", () => {
    const eslintRequire = createRequire(runtimeRequire.resolve("eslint"));
    const minimatch3PackageJson = eslintRequire.resolve("minimatch/package.json");
    const minimatch3Require = createRequire(minimatch3PackageJson);
    const minimatch3BraceExpansionPackageJson = minimatch3Require.resolve(
      "brace-expansion/package.json",
    );

    const typescriptEstreeRequire = createRequire(
      runtimeRequire.resolve("@typescript-eslint/typescript-estree/package.json"),
    );
    const minimatch9PackageJson = typescriptEstreeRequire.resolve(
      "minimatch/package.json",
    );
    const minimatch9Require = createRequire(minimatch9PackageJson);
    const minimatch9BraceExpansionPackageJson = minimatch9Require.resolve(
      "brace-expansion/package.json",
    );

    const googleGaxRequire = createRequire(runtimeRequire.resolve("google-gax"));
    const rimrafRequire = createRequire(googleGaxRequire.resolve("rimraf"));
    const globRequire = createRequire(rimrafRequire.resolve("glob"));
    const minimatch10PackageJson = globRequire.resolve("minimatch/package.json");
    const minimatch10Require = createRequire(minimatch10PackageJson);
    const minimatch10BraceExpansionPackageJson = minimatch10Require.resolve(
      "brace-expansion/package.json",
    );

    expect(readPackageVersion(minimatch3PackageJson)).toBe("3.1.5");
    expect(readPackageVersion(minimatch3BraceExpansionPackageJson)).toBe("1.1.18");
    const expandBrace = minimatch3Require("brace-expansion") as (
      pattern: string,
    ) => string[];
    expect(expandBrace("x{1,2}y")).toEqual(["x1y", "x2y"]);

    expect(readPackageVersion(minimatch9PackageJson)).toBe("9.0.9");
    expect(readPackageVersion(minimatch9BraceExpansionPackageJson)).toBe("2.1.4");

    expect(readPackageVersion(minimatch10PackageJson)).toBe("10.2.5");
    expect(readPackageVersion(minimatch10BraceExpansionPackageJson)).toBe("5.0.9");
  });

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
