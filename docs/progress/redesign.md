# Redesign — dashboard frame, navigation and analytics reports

Outside the eight lanes, asked for by the owner on 2026-10-03: the dashboard
should look like Hi.Events (layout only, no code taken), the navigation should
be ordered sensibly, and analytics should be at the level of Shopify,
EasyOrders and LightFunnels. Worktrees `zimos-lanes/redesign/{backend,frontend}`,
branch `redesign`, database `zimos_redesign`, ports 4110 / 5210 / 3210 / 5310.
No migrations.

## Done
- [x] Dashboard frame: navy sidebar + top bar, store switcher in the sidebar, breadcrumb strip, account at the bottom; cooler page palette, sans headings — checked on :5210 in English and Arabic.
- [x] Navigation regrouped: Orders, Products, Customers, Marketing, Online store, Analytics, Money & shipping, then apps/settings/help.
- [x] `GET /analytics/reports/{sales,products,delivery,customers,insights,export}` (`modules/analytics/reportsService.js`) — run against 1,189 seeded orders.
- [x] Analytics page (`pages/analytics/reports`): Overview, Products, Delivery, Customers tabs, date presets + custom dates + comparison, insights, CSV export — opened on :5210 in English and Arabic. The old page is at `/analytics/summary`.

## Decisions
- The frame carries the `dark` class so shared controls inside it use the dark tokens in both themes; the notification drawer and the command palette are mounted on `<body>` so they follow the page theme.
- Rates stay percentages with one decimal, like the rest of the analytics module.
- `zimos_redesign` holds seeded demo orders, shipments and visits (a scratch script, not in the repo).

## Not checked
- The mobile drawer and the dark theme were not opened.
- The CSV download button was not clicked in the browser; the export was run through the service.
