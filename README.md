# rsa

Responsive search ads pipeline for ponly.com articles. A separate project from the display pipeline: its own repo, Railway project, Sheet and database.

**Flow:** grouping file in a Google Sheet → ad copy by Claude Haiku 5.5 (Message Batches API) → checks → Google Ads Search campaigns, created **paused** → you tick a box to enable, pilot first.

Grouping and ad copy rules come from [abhishekblue/n8n-bulk-google-ads](https://github.com/abhishekblue/n8n-bulk-google-ads) (`scripts/bulk-rsa`).

## What it creates

| Item | Setting |
|---|---|
| Campaign | `Ponly Faith \| <Bible book or theme of its first ad group> \| 0001`, Search, **paused** |
| Networks | Google Search only (no search partners, no Display Network) |
| Bidding | Maximize clicks, max CPC ₹3 |
| Budget | ₹2,700 a day per campaign (not shared) |
| Location / language | United States (presence: people in the US) / English |
| Label | `Ponly Faith` |
| Tracking | final URL suffix, see `src/config.ts` (`FINAL_URL_SUFFIX`); gclid needs auto-tagging on in the account |
| Automatically created text assets | off |
| Ad groups | the repo's grouping: up to 3 articles per ad group, up to 4 ad groups per campaign |
| Keywords | 1 per article, phrase match |
| Ads | 1 responsive search ad per article (15 headlines, 4 descriptions), final URL = the article |

All settings are in `src/config.ts`. Account IDs are never in the code (this repo is public): the Google Ads account ID goes in the Sheet, the MCC ID in Railway.

## 1. Make the Input file

```bash
npm install
node scripts/group.ts articles.csv input.csv
```

`articles.csv` has the columns `URL, Title, Keywords`. `input.csv` gets `Campaign, Ad Group, Keyword, Title, URL, Wave`. The pilot is the first campaigns, whole, until at least 100 articles.

## 2. Sheet

1. Create a new Google Sheet. Rename the first tab to **Input** and paste `input.csv` into it (File → Import → Upload → *Replace current sheet*).
2. Share the Sheet with the service account's email (the `client_email` in the service account JSON), as **Editor**.
3. The worker adds the other tabs itself: **Settings**, **Output**, **Summary** and **Campaign map**.

## 3. Railway

1. New project → Deploy from GitHub repo → `sid2809/rsa`.
2. Add a **volume** to the service with mount path `/data`.
3. Add these variables:

| Variable | Value |
|---|---|
| `SHEET_ID` | the new Sheet's ID (from its URL) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the service account JSON (same as display) |
| `ANTHROPIC_API_KEY` | same as display |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | same as display |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | the MCC ID (same as display) |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` | OAuth login (same as display) |

The logs say `rsa worker started` when everything is set. Missing variables are listed as `Waiting for Railway variables: ...`.

## 4. Settings tab

| Setting | What it does |
|---|---|
| Account | Google Ads account ID the campaigns go in |
| Pause | TRUE stops the worker. It does **not** pause campaigns in Google Ads |
| Daily API quota cap | operations per 24 h for this tool. This cap + display's cap must be 15,000 or less |
| Upload pilot | ad copy for the pilot → preflight → pilot campaigns uploaded, paused |
| Enable pilot | untick → tick enables the pilot campaigns uploaded so far, once |
| Upload rest | ad copy for the rest → uploaded, paused, within the daily cap. Starts after every pilot campaign is done |
| Enable rest | untick → tick enables the rest campaigns uploaded so far, once. Tick it after **Summary** shows all rest campaigns uploaded |

## Safety

- **Preflight** (once, before the first upload): checks the account currency is INR, checks a real pilot campaign with Google without creating it, creates a test campaign, reads its settings back from Google, then removes it. If it fails, nothing is uploaded and the reason is in **Summary**. Fix it and restart the service.
- Each campaign is created in **one atomic request**: all of it, or nothing. If Google rejects specific ads or keywords, those articles are left out (reason in **Output**) and the rest is sent again.
- Before uploading, the worker checks which `Ponly Faith |` campaigns already exist in Google Ads, so a crash never creates a campaign twice.
- Haiku batch IDs are saved before waiting; a restart picks the batch up instead of sending a new one. Articles whose copy fails are retried up to 3 times, then left out.
- Every Google Ads call (queries included) counts against the daily cap. When the cap is reached, the worker waits and carries on later.
- Approval status is read from Google Ads once a day (and after uploads) into **Output**; **Summary** shows the pilot pass rule: at least 95% of reviewed ads approved and no clickbait or misrepresentation flags.

## Development

```bash
npm test        # offline tests with fake Google Ads, Anthropic and Sheets
npm run typecheck
```

Node 22 runs the TypeScript directly (no build step).
