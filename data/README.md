# Data files

## Included in git (small enough for GitHub)

| File | Description |
|---|---|
| `fake reviews dataset.csv` | Labeled fake/genuine reviews for training and demos |
| `Synthetic Reviews Complete May 21 2026.csv` | Synthetic review samples for validation |

## Local only (too large for GitHub)

| File | Size | Notes |
|---|---|---|
| `All_Beauty.jsonl` | ~311 MB | Amazon Beauty category reviews (JSONL). **Not tracked in git.** |

Place `All_Beauty.jsonl` in this folder yourself if you need it for graph/burst analysis notebooks. The web app and ML API work without it — upload any CSV/JSONL from the UI instead.

If you already have the file locally, keep it here; `.gitignore` prevents accidental commits.
