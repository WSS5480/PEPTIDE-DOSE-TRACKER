# Updating the Dose Guide

The app reads `updates.json` every time it opens. Edit that file and commit; no change to index.html is needed.

- `news`: items shown under What's new (date, kind fda/study/new/safety/other, title, summary, https url, tags = peptide ids)
- `status`: change a peptide's badge, e.g. `"bpc157": {"status":"...","label":"...","note":"..."}`
- `append`: add notes, evidence line or sources to an existing peptide
- `peptides`: add whole new peptides (validated; bad entries are ignored)
- `notice`: a banner shown at the top

Dose numbers for existing peptides are never changed by the feed. Change those in index.html by hand, with a source.
Live study and FDA lookups (PubMed, ClinicalTrials.gov, openFDA) run in the phone on demand and are cached 12 h.
