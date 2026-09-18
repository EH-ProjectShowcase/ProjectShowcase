# 🎓 Project Showcase

A permanent, public gallery of student capstone projects — zero technical barrier for students, zero ongoing cost, zero long-term fragility.

## How it works

1. **Students submit** via a Google Form (no GitHub account needed)
2. **You approve** by setting `Approved = TRUE` in the linked Google Sheet
3. **Automation runs hourly**, pulling approved submissions:
   - Screenshots → compressed and committed to the repo
   - Implementation zips → uploaded to GitHub Releases (no repo bloat)
   - `projects.json` → updated and committed
   - Drive originals → deleted (Drive never fills up)
4. **GitHub Pages auto-deploys** the updated site

## Quick start

### 1. Create a Google Form

Questions to add:
- Your Full Name (Short answer)
- Project Title (Short answer)
- Department (Short answer or dropdown)
- Batch (Short answer)
- Short Description (Paragraph)
- Tech Stack (Short answer — comma-separated)
- Source Code URL (Short answer, URL validation)
- Live / Demo URL (Short answer, URL validation)
- Screenshot (upload) (File upload, image types, max 10 MB)
- Implementation (.zip) (File upload, .zip only, max 50 MB)

Link the form to a Google Sheet.

### 2. Set up a GCP Service Account

1. Create a service account in Google Cloud Console
2. Enable the Google Sheets API and Google Drive API
3. Download the JSON key
4. Share the Google Sheet with the service account email (Viewer)
5. Share the Form's Drive folder with the service account email (Editor — needed for cleanup)

### 3. Add GitHub Secrets

In your repo settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full JSON key contents |
| `SHEET_ID` | The spreadsheet ID from the Sheet URL |

### 4. Add the "Approved" column

In the Google Sheet, add a column called `Approved` (manually, after the form response columns). Set it to `TRUE` for submissions you want to publish.

### 5. Deploy

Push to `main` — the deploy workflow will publish `site/` to GitHub Pages. The sync workflow runs every hour (or trigger it manually from Actions tab).

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full data flow and design decisions.