# Optional raster basemap

The map starts without a basemap. Settings can hold one raster tile template, XYZ or TMS numbering, and attribution entered by the operator. There is no suggested address or separate key field. The saved source loads only after the operator enables it and opens a map.

The template must use HTTP or HTTPS and contain `{z}`, `{x}` and `{y}` in its path or query. User information, fragments, host placeholders and other placeholders are rejected. Attribution is plain text. The browser omits credentials for another origin and sends no referrer. Tile servers must permit browser reads with CORS. Mixed-content restrictions still apply when using an HTTP source from an HTTPS page.

Only the enabled source's fixed origin is added to the page's image and connection policies. Saving a different origin, enabling the source, or disabling it reloads the document to apply the policy. The map request policy also checks the expanded template. A source error names the saved address and leaves the result layers visible. A slow settings response preserves the map position and selected layers when it arrives.

## Evidence

- `server/settings/routes.test.ts` checks empty defaults, save and reload, database reopening, invalid templates and rejection without changing saved settings.
- `server/http/security-headers.test.ts` and `server/http/routes.test.ts` check the default policy and the enabled origin on page, API and error responses. Paths and query values are never added to the policy.
- `web/src/basemap/BasemapSettings.test.tsx` checks the empty labelled form and its entry point on the settings page.
- `web/src/basemap/map-request.test.ts` checks that external reads match the saved tile template and resource type.
- `web/src/basemap/Basemap.browser.test.ts` uses Chromium with actual page security headers and a controlled tile server. It checks no external tile requests with empty or disabled settings, default-policy blocking, save errors, policy reload, both numbering schemes, literal attribution, delayed settings, source failures and visible result pixels after failure.
- `web/src/map/MapView.browser.test.ts` retains the offline map controls and result-request checks.

The first settings endpoint test returned 404. The first component and request-policy tests failed on missing modules. The first configured-source browser check made no basemap request before the map integration existed. A delayed settings response then reproduced a map reset from longitude 24.284168 to 0; the regression now checks that the chosen center is retained.

Test depth is unit. This change covers settings, page policy and the map interface. It does not change job preparation, engine installation, signing or updates. Hosted executable builds validate the production bundle. No new dependency is needed.
