# src/theme

Design tokens land here: `tokens.ts`, `tailwind-preset.js`, `typography.ts`,
`charts.ts` (SAD §4.2).

Until then, raw hex colours in `.tsx` are banned by ESLint; theme values go in
`tailwind.config.js`'s `theme.extend.colors`.
