# MCSP manifest format (v1) — `pack/manifest.json`

Custom format (no .mrpack anywhere, per project decision). The backend is the
single source of truth; it publishes this file and keeps it consistent with
the actual files in `server/mods/`.

```json
{
  "formatVersion": 1,
  "loader": "neoforge",
  "loaderVersion": "21.1.259",
  "minecraftVersion": "1.21.1",
  "restartRequired": false,
  "updatedAt": "2026-10-14T03:00:00Z",
  "mods": [
    {
      "modId": "create",
      "name": "Create",
      "version": "6.0.4",
      "side": "both",
      "file": {
        "url": "https://cdn.example.org/create-6.0.4.jar",
        "filename": "create-6.0.4.jar",
        "size": 19834512,
        "hashes": { "sha1": "<40 hex>" }
      },
      "iconUrl": "https://example.org/create.png",
      "notes": null
    }
  ]
}
```

## Per-mod `side` classification (REQUIRED, enforced)

| value    | client installs | backend installs on managed server |
|----------|-----------------|------------------------------------|
| `client` | yes             | **rejected** (`side_mismatch`)     |
| `server` | **skipped** (never downloaded) | yes                 |
| `both`   | yes             | yes                                |

- The backend validates `side` at the schema level (unknown values are 422
  before any download or file write).
- The client's sync planner excludes `side=server` from its download set and
  sweeps any stale server-only files out of the player's instance.
- Download URLs are arbitrary http(s) — the manifest comes from a server the
  player chose to trust (no whitelist, per decision). sha1 is verified on both
  sides; zip-entry traversal is rejected.
