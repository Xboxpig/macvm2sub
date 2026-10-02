# CPA-Manager-Plus frontend sources

Source: https://github.com/seakee/CPA-Manager-Plus

Pinned commit: `05ebb7f275dbe575211cb886436d4b99936c1cd9`

All upstream paths below are relative to `apps/web/src/`.

- `features/usage-analytics/`: the original complete analytics page, SCSS, hooks,
  presentation models, summary cards and UI-state helpers. The page and chart
  components retain upstream layouts and interactions, including the six tabs,
  time/model/status filters, heatmap and drilldown.
- `components/charts/`: upstream ECharts wrapper and registered chart modules.
- `components/ui/`, `components/config/`: upstream controls, segmented tabs,
  configuration sections, source editor and diff-confirmation dialog.
  `ConfigSourceEditor` uses JSON syntax for this gateway's `settings.json`.
- `features/config/ConfigPage.module.scss`,
  `components/config/VisualConfigEditor.module.scss`, and
  `features/oauth/OAuthPage.module.scss`: upstream page styles. OAuth SCSS adds an
  explicit variables import, which the upstream build injects globally.
- `styles/`, `assets/icons/codex.svg`, supporting `utils/` and `types/`: upstream
  theme, icon, formatting and shared type dependencies.
- `i18n/locales/`: upstream Chinese and English translations, reduced to namespaces
  used by these pages.

Local integration adapters replace the upstream stores, service transport,
monitoring availability, credential metadata and model-price-attention hook.
`services/api/usageService.ts` retains the upstream analytics wire types and calls
the authenticated local `/api/analytics` endpoint. `utils/usage.ts` displays `—`
for monetary values because this subscription gateway has no configured pricing.

`../../pages/SettingsPage.tsx` adapts upstream ConfigPage and VisualConfigEditor
markup to the gateway's model, session, timeout and retention settings.
`../../pages/OAuthPage.tsx` adapts the upstream Codex provider card and callback
form to the official CLI's browser/device login lifecycle. Neither page imports
CPA-specific account pools or other providers.

`SOURCE-MANIFEST.json` records the upstream and local SHA-256 for each vendored
file with a matching upstream path; files marked `adapted` have local edits.
The original MIT LICENSE, copyright 2026 Seakee, is retained alongside these files.
The surrounding application and API integration are maintained by macvm2sub.
