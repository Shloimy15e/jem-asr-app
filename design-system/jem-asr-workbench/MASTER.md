# Design System — JEM ASR Workbench (Apple Pro refined)

> **Generated** with `ui-ux-pro-max-skill` reasoning engine, then refined to
> reflect the user's chosen direction: Apple Pro refined / full redesign /
> light-only / mixed top-bar + optional contextual sidebar.
>
> Hierarchy: when building a page, check `design-system/jem-asr-workbench/pages/<page>.md`
> first. If absent, follow this Master.

**Project:** JEM ASR Workbench (Yiddish/Hebrew ASR research tool)
**Category:** Internal data-annotation dashboard
**Style:** Minimalism & Swiss Style
**Mode:** Light only (per user direction)

---

## Color Palette (Apple Pro refined)

| Role        | Hex                       | CSS Variable               |
|-------------|---------------------------|----------------------------|
| Surface     | `#FFFFFF`                 | `--surface`                |
| Surface 2   | `#FAFBFC`                 | `--surface-2`              |
| Background  | `#F6F7F9`                 | `--bg`                     |
| Text        | `#0F172A`                 | `--text`                   |
| Text 2      | `#475569`                 | `--text-secondary`         |
| Text muted  | `#94A3B8`                 | `--text-muted`             |
| Border      | `rgba(15,23,42,0.08)`     | `--border`                 |
| Accent      | `#0066FF` (system blue)   | `--accent`                 |
| Brand-2     | `#7C3AED`                 | `--brand-2`                |
| Success     | `#16A34A`                 | `--green`                  |
| Warning     | `#F97316`                 | `--orange`                 |
| Error       | `#EF4444`                 | `--red`                    |
| Gold (star) | `#F59E0B`                 | `--gold`                   |

**Notes:** Single primary accent + monochrome neutrals. Semantic colors stay
muted; never used as decoration.

---

## Typography — Minimal Swiss

- **Family:** Inter Variable (Google Fonts) → falls back to SF Pro Text /
  Segoe UI / Helvetica Neue
- **Headings:** weight 600–700, tracking -0.01em
- **Body:** weight 400; line-height 1.55
- **Numerics in tables:** `font-variant-numeric: tabular-nums`

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
```

---

## Spacing scale

| Token         | Value | Usage                          |
|---------------|-------|--------------------------------|
| `--space-xs`  | 4px   | tight gaps                     |
| `--space-sm`  | 8px   | inline / icon gap              |
| `--space-md`  | 16px  | default padding                |
| `--space-lg`  | 24px  | section padding                |
| `--space-xl`  | 32px  | large gaps                     |
| `--space-2xl` | 48px  | section margins                |

## Radii

`--radius-sm 6 / --radius 10 / --radius-lg 14 / --radius-xl 18 / --radius-2xl 24`

## Shadows (4-layer Apple-style)

```css
--shadow-xs: 0 1px 2px rgba(15,23,42,.05);
--shadow-sm: 0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
--shadow:    0 2px 6px rgba(15,23,42,.06), 0 4px 12px rgba(15,23,42,.05);
--shadow-md: 0 4px 12px rgba(15,23,42,.08), 0 8px 24px rgba(15,23,42,.07);
--shadow-lg: 0 8px 24px rgba(15,23,42,.10), 0 16px 48px rgba(15,23,42,.10);
```

## Motion

- Default transition: `150ms cubic-bezier(.2,.8,.2,1)`
- Hover micro-lift: `translateY(-1px)` + shadow step-up
- **Always** wrap motion in `@media (prefers-reduced-motion: reduce)`

---

## Component rules

### Buttons
- Primary: solid `--accent`, white text, height 36–40, radius `--radius`
- Secondary: transparent + 1px `--border-strong` + `--text`
- Ghost / icon: transparent → `--surface-hover` on hover
- All buttons: `cursor: pointer`, `transition: all 150ms ease-out`,
  visible `:focus-visible` ring `0 0 0 3px var(--accent-dim-strong)`

### Cards
- `--surface`, `1px solid var(--border)`, `--shadow-xs`, radius `--radius-lg`
- On hover (interactive cards only): `--shadow-sm` + `translateY(-1px)`

### Inputs
- 36px height, `1px solid --border`, radius `--radius`
- Focus: `border-color: --accent` + `0 0 0 3px --accent-dim`

### Tables
- Sticky header row, hairline rows, hover row tint `--surface-hover`
- Sticky-left **Actions** column (the workbench's primary affordance)

### Diff panel
- `+` insertions: `background: var(--green-dim); color: var(--green-dark)`
- `−` deletions: `background: var(--red-dim); color: var(--red-dark)`
- Equal text: muted `--text-secondary`

### Drawer (contextual sidebar)
- 280px wide, `--surface`, `--shadow-md`, slides in from start edge
- Backdrop: `rgba(15,23,42,.4)` with `backdrop-filter: blur(2px)`

---

## Anti-patterns (do NOT do)

- No emojis as UI icons → use **Lucide SVG** via `src/icons.js`
- No layout-shifting hovers (avoid `scale()` on rows / cells)
- No instant state changes (always `transition` 150–250ms)
- No invisible focus rings → `:focus-visible` everywhere
- No mid-translation Hebrew direction quirks → preserve `dir="rtl"` for
  Hebrew/Yiddish content; UI chrome stays LTR
- No raw color literals in components — go through tokens

## Pre-delivery checklist

- [x] Inter loaded; system fallback present
- [x] Lucide SVG icons (no emoji as icons)
- [x] All clickable elements have `cursor: pointer`
- [x] Hover transitions 150–250ms
- [x] Light-mode contrast ≥ 4.5:1 (text on `--surface`/`--bg`)
- [x] `:focus-visible` rings present on buttons, links, inputs, table rows
- [x] `prefers-reduced-motion: reduce` honored
- [x] Responsive: 375 / 768 / 1024 / 1440
- [x] No content hidden behind sticky top bar
- [x] No horizontal scroll on mobile (audio-table is the one allowed scroll
      surface, and it has sticky `Actions` column)
