// Every campaign setting Siddharth decided (10 Nov 2026). Account IDs are NOT here: this repo is public.
// The Google Ads account ID is typed into the Sheet (Settings tab); the MCC ID is a Railway variable.

// Campaign
export const CAMPAIGN_BUDGET_INR = 2700; // per campaign, per day
export const MAX_CPC_INR = 3; // Maximize clicks, CPC capped at this
export const LOCATION_ID = '2840'; // United States
export const LOCATION_TARGETING = 'PRESENCE' as const; // people in the US, not people interested in the US
export const LANGUAGE_ID = '1000'; // English
export const LABEL_NAME = 'Ponly Faith';
// Display's "enhancements off": Google's automatically created text assets switched off.
export const TEXT_ASSET_AUTOMATION_OFF = true;

// Google Search only: no search partners, no Display Network.
export const NETWORKS = {
  target_google_search: true,
  target_search_network: false,
  target_partner_search_network: false,
  target_content_network: false,
};

// Tracking. Google fills the {braces} at click time. gclid needs auto-tagging on in the account.
export const FINAL_URL_SUFFIX = [
  'utm_source=google',
  'utm_medium=cpc',
  'utm_campaign={campaignid}',
  'adgroup={adgroupid}',
  'utm_content={creative}',
  'utm_term={keyword}',
  'matchtype={matchtype}',
  'targetid={targetid}',
  'network={network}',
  'device={device}',
  'loc={loc_physical_ms}',
  'loc_int={loc_interest_ms}',
  'adpos={adposition}',
].join('&');

// Keywords: one per article, phrase match.
export const KEYWORD_MATCH_TYPE = 'PHRASE' as const;

// Responsive search ads (limits from the n8n node's defaults.ts)
export const HEADLINES_WANTED = 15;
export const DESCRIPTIONS_WANTED = 4;
export const MIN_HEADLINES_REQUIRED = 3;
export const MIN_DESCRIPTIONS_REQUIRED = 2;
export const MAX_HEADLINE_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 90;

// Ad copy: Claude Haiku 5.5 through the Message Batches API
export const MODEL = 'claude-haiku-5-5';
export const COPY_MAX_ATTEMPTS = 3; // per article; after that the article is left out and listed as failed
export const COPY_MAX_TOKENS = 4000;

// Uploads
export const UPLOAD_MAX_ATTEMPTS = 3; // per campaign
export const DEFAULT_DAILY_QUOTA_CAP = 14000; // Basic access is 15,000 a day, shared with the display pipeline

// Waves, in order. A wave's campaigns are only uploaded after its "Upload" box is ticked in the Sheet.
export const WAVES = ['pilot', 'rest'] as const;
export type Wave = (typeof WAVES)[number];

// Pilot pass rules (same as display)
export const PILOT_MIN_APPROVED_SHARE = 0.95;
export const PILOT_BLOCKING_POLICY_WORDS = ['CLICKBAIT', 'MISREPRESENTATION'];

// Worker timing
export const TICK_SECONDS = 60;
export const SYNC_EVERY_HOURS = 24;
export const SHEET_WRITE_MIN_SECONDS = 120;
