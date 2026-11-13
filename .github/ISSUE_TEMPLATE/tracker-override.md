---
name: Tracker override
about: Request a new tracker or correct a tracker-specific browser search rule
title: '[Tracker override] '
---

## Tracker

- **Name:**
- **Homepage:**
- **Prowlarr definition ID (if available):**
- **Codebase (if known):**

## Reason for override

- [ ] Tracker is missing from the generated index
- [ ] Generated browser search URL is wrong or incomplete
- [ ] Category filtering is wrong
- [ ] Other (describe below)

**Current behavior:**

**Expected behavior:**

## Verified search format

- **Working browser search URL with an ordinary example term:**
- **Query parameter / path segment:**
- **Category parameters and native IDs (if tested):**
- **Tests performed / results:**

**Proposed JSON entry (optional; same schema as `data/tracker-overrides.json`):**

```json
{
  "id": "tracker:example",
  "homepage": "https://example.org/",
  "search": {"path": "browse.php", "query_param": "search"}
}
```

Please include only fields that need overriding for an existing tracker. Provide `id`, `name`, and `homepage` for a new tracker.

Do not submit passkeys, API keys, cookies, or other credentials.
