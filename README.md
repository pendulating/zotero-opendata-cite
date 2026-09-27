# OpenData Cite for Zotero

A Zotero 9/10 plugin that saves datasets from open data portals as proper Zotero
**Dataset** items, with the publishing agency as author, the portal as repository,
and a child note holding API links and the column list.

```
Office of Technology and Innovation (OTI). (2026). Centerline [Geospatial dataset].
    NYC Open Data. https://data.cityofnewyork.us/d/inkn-q76z
```

## Supported portals

| Platform | Examples | How it reads metadata |
|---|---|---|
| **Socrata** | data.cityofnewyork.us, data.cityofchicago.org, data.sfgov.org | `/api/views/{id}.json` |
| **CKAN** | data.boston.gov, open.canada.ca/data, many national portals | `/api/3/action/package_show` |

Any URL containing a Socrata dataset ID (`xxxx-xxxx`) or a CKAN `/dataset/<name>` path works,
e.g. `…/City-Government/Centerline/inkn-q76z/about_data`, `…/d/inkn-q76z`, `…/resource/inkn-q76z.json`.

## Using it

- **File → Add Open Data Dataset from URL…** Paste one or more URLs, separated by spaces. If a
  dataset URL is on your clipboard, the box is pre-filled. Items go into the selected library/collection.
  A dataset already in the library is selected instead of duplicated.
- **Right-click an item → Update Open Data Metadata** re-fetches the portal record (new
  "last updated" date, description changes). Your own tags and Extra lines are kept, and the
  details note is replaced, not duplicated. In Zotero 10 this can be undone.
- **Settings → OpenData Cite** picks which portal date becomes the item's Date (default: when the
  data was last updated, the usual choice for continuously updated data) and toggles the details note.

### Field mapping

| Zotero field | Socrata | CKAN |
|---|---|---|
| Title / Abstract | `name` / `description` (HTML stripped) | `title` / `notes` (localized) |
| Author (institutional) | Agency/department custom field → `attribution` → owner | organization → author → publisher |
| Date | data last updated (configurable) | newest resource update (configurable) |
| Repository | portal name from the page title | `site_title` from `status_show` |
| Type | Geospatial / Tabular dataset | Dataset |
| Version, DOI, Language | — | `version`, DOI in fields/extras, `language` |
| Rights | license | `license_title` |
| Extra | `Dataset ID`, `Platform` | `Dataset ID`, `Platform`, `Formats` |
| Tags (automatic) | tags + category | tags, keywords, groups |

The portal ID and file formats go in **Extra** rather than the Identifier/Format/Library Catalog
fields on purpose: CSL styles print those as "No. Inkn–Q76z", swap APA's `[Dataset]` for
`[CSV, PDF]`, or repeat the hostname.

## Development

A Zotero plugin is a zip (`.xpi`) of `addon/`. Zotero runs `bootstrap.js` hooks
(`startup`, `shutdown`, `onMainWindowLoad`, …), which load the other scripts.

```
addon/
  manifest.json            plugin ID and supported Zotero versions
  bootstrap.js             lifecycle hooks
  prefs.js                 default preferences
  locale/en-US/*.ftl       UI strings (Fluent)
  content/providers.js     portal → record mapping (plain JS, no Zotero APIs, unit-tested)
  content/opendata-cite.js Zotero integration: menus, saving items, notes, updates
  content/preferences.xhtml settings pane
test/                      Node tests with saved API responses
```

```sh
npm test                    # unit tests (Node 18+), no network needed
npm run build               # -> build/opendata-cite-<version>.xpi
```

**Install a build:** Zotero → Tools → Plugins → gear menu → *Install Plugin From File…* → pick the `.xpi`.

**Live-edit setup:** quit Zotero, run `sh scripts/dev-install.sh` (optionally passing a profile path),
then start Zotero. The profile now loads `addon/` directly: edit, restart Zotero, and the change is live.
Start Zotero with `-ZoteroDebugText -jsdebugger` for debug output and devtools, and use
*Tools → Developer → Run JavaScript* to poke at `Zotero.OpenDataCite`.

### Adding a portal platform

Add a provider object to `providers.js` with `match(url)`, `fetch(match, ctx)`, and a pure
`toRecord(...)`, list it in `PROVIDERS`, and add a fixture-based test. ArcGIS Hub
(`hub.arcgis.com` and many city portals) and OpenDataSoft are the obvious next candidates.

### References

- [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers) (plugin structure)
- [Zotero 8 for Developers](https://www.zotero.org/support/dev/zotero_8_for_developers) (`Zotero.MenuManager`)
- [Zotero 10 for Developers](https://www.zotero.org/support/dev/zotero_10_for_developers) (multi-selection, undo)
- [Zotero schema](https://github.com/zotero/zotero-schema) (`dataset` item type fields)
