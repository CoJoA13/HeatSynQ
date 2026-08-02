// Flat config, importing eslint-config-next's own flat exports directly.
//
// This used to go through `FlatCompat` from `@eslint/eslintrc`, which wrapped the old
// eslintrc-style `next/core-web-vitals` and `next/typescript` shareable configs. eslint-config-next
// 16 ships real flat-config arrays instead, and running the new package through the compat layer
// crashes it — the legacy validator hits a circular reference ("property 'react' closes the
// circle") while trying to serialize the config for an error message. Importing the arrays is both
// the supported path now and one less indirection, and `@eslint/eslintrc` stops being a dependency
// of this project entirely.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // OFF DELIBERATELY, and not because it was inconvenient — see the reasoning before changing.
      //
      // eslint-config-next 16 turns on the React Compiler's hook rules, and this one fires 21
      // times across 19 files, every hit the same shape:
      //
      //     const load = useCallback(async () => { const data = await api(...); setRows(data); }, [...]);
      //     useEffect(() => { void load(); }, [load]);
      //
      // The rule's own message is about setState *synchronously* in an effect body causing
      // cascading renders. That is not what these do: the setState runs in an async continuation
      // after the fetch resolves, by which point the effect has long returned. The rule follows
      // the call into `load`, sees a setState, and cannot tell the two apart.
      //
      // Satisfying it for real would mean this app stops fetching in effects — a data-fetching
      // library, or moving these pages to Server Components. That is a genuine architectural
      // direction Next 16 nudges toward and may well be right, but it is a decision about 19
      // pages, not a detail of a version bump, and it is tracked separately. Turning the rule to
      // `warn` was rejected: 21 warnings on every run is noise that teaches people to skim past
      // lint output, which costs more than the rule buys here.
      //
      // Narrow in scope on purpose: every other React Compiler rule the new config enables stays
      // on, including `react-hooks/refs`, which found a real lazy-init-ref smell in use-latest.ts
      // and was fixed rather than silenced.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "prisma/generated/**",
    ],
  },
];

export default eslintConfig;
