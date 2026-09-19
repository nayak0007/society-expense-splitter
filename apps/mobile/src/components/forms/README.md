# src/components/forms

Feature-agnostic form primitives (SAD §4.2): `FormField`, `AmountInput`,
`DateField`, `SelectField`.

`AmountInput` is the important one — it must bind to React Hook Form and
round-trip integer paise (PRD §18: money fields are always `*Paise`; no
floats). These land with the first real forms (Phase 3, society setup).
