---
name: Tracker compatibility report
about: Report a working or broken tracker search/category URL
---

## Tracker

- **Tracker name:**
- **Website URL:**
- **Prowlarr definition ID (if known):**
- **Codebase (if known):**

## What did you test?

- [ ] Title search works
- [ ] Title search does not work
- [ ] Category filter works
- [ ] Category filter does not work
- [ ] Request category normalization is incorrect

**Category family:** Movies / TV / Audio / Books / PC / Console / XXX / Other

**Example search URL (remove personal tokens/cookies/API keys):**

```text

```

**Expected result:**

**Actual result:**

## Proposed rule or fix (optional)

If known, show the corrected browser GET path and query/category parameters.
Please avoid publishing cookies, API keys, private torrent links, or other
credentials. A screenshot of the search form can help when a URL is unknown.

## Recording verified test results

For a pull request, record verified outcomes in `data/tracker-tests.json` using
`passed`, `failed`, or `untested` (never count untested as failed). The JSON key
is the tracker homepage hostname without `www.`:

```json
{
  "example.org": {
    "search": "passed",
    "categories": {"Movies": "passed", "TV": "failed"}
  }
}
```

Report only the categories you actually tested. Unlisted categories remain untested.
