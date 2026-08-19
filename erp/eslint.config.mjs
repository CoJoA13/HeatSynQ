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
      // OFF PERMANENTLY — an owner decision (issue #31, ruled 2026-08-18), not a deferral.
      //
      // eslint-config-next 16 turns on the React Compiler's hook rules, and this one fires on
      // every fetch-into-state effect in the app, all the same shape:
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
      // library, or moving these pages to Server Components. The owner ruled against both: the
      // build is complete, the pages are tested, and either would be a real migration over
      // working paper for consistency rather than correctness. Fetching in effects stays, and
      // the discipline the rule cannot see is src/lib/use-latest.ts (tickets on both the success
      // and rejection paths) plus its siblings — enforced across the codebase by the Round 2
      // Group D sweep rather than by this rule. Turning it to `warn` was rejected: dozens of
      // warnings on every run is noise that teaches people to skim past lint output, which costs
      // more than the rule buys here.
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
