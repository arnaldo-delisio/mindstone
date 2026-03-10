# Google Calendar Integration Setup

This guide walks you through connecting MindStone to Google Calendar. After completing it, events you create via MindStone's `manage_event` MCP tool will appear in your Google Calendar — and changes made directly in Google Calendar will sync back to your vault.

**Time required:** 15–20 minutes (most of it is Google Cloud Console setup).

---

## Prerequisites

Before you start, make sure you have:

- A Google account (the one whose calendars you want to sync)
- Access to [Google Cloud Console](https://console.cloud.google.com/) — free, no billing required for Calendar API
- The MindStone intelligence service running on Railway (Phase 1 setup complete)
- Node.js installed locally (v18+) — needed for the one-time token script in Section 5

---

## Section 1: Create a Google Cloud Project

1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. In the top navigation bar, click the project selector dropdown (next to the Google Cloud logo)
3. Click **New Project**
4. Name it anything (e.g. "MindStone") and click **Create**
5. Wait a few seconds for the project to be created, then select it from the project dropdown

---

## Section 2: Enable the Google Calendar API

1. In the left sidebar, go to **APIs & Services** → **Library**
2. In the search box, type "Google Calendar API"
3. Click on **Google Calendar API** in the results
4. Click **Enable**

Wait for the API to enable before continuing.

---

## Section 3: Configure the OAuth Consent Screen

This tells Google what your app is and who can use it. For personal use, you will add yourself as a "test user."

1. In the left sidebar, go to **APIs & Services** → **OAuth consent screen**
2. Under "User Type," select **External** and click **Create**
3. Fill in the required fields on the App Information page:
   - **App name:** MindStone (or any name you like)
   - **User support email:** your Google account email
   - **Developer contact information:** your Google account email
4. Click **Save and Continue**

5. On the **Scopes** page, click **Add or Remove Scopes**
6. In the filter box, search for "Google Calendar API"
7. Check the scope `https://www.googleapis.com/auth/calendar` (Full access to Google Calendar)
8. Click **Update**, then click **Save and Continue**

9. On the **Test users** page, click **Add Users**
10. Enter your own Google account email address and click **Add**
11. Click **Save and Continue**

12. Review the summary and click **Back to Dashboard**

> **Why "External" and "Test users"?** Google requires an app to go through a verification process before it can be used by the general public. For personal use, staying in "testing" mode with yourself as a test user is fine — you don't need Google to verify the app.

---

## Section 4: Create OAuth2 Client Credentials

1. In the left sidebar, go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth 2.0 Client ID**
3. Under "Application type," select **Desktop app**
4. Give it a name (e.g. "MindStone Desktop") and click **Create**
5. A dialog will appear showing your **Client ID** and **Client Secret** — keep this dialog open, or click the download button to save the credentials JSON file
6. Note down:
   - `client_id` — a long string ending in `.apps.googleusercontent.com`
   - `client_secret` — a shorter alphanumeric string

You will need both values in the next steps.

---

## Section 5: Get Your Refresh Token (One-Time Step)

Google Calendar requires OAuth2 authorization. You authorize once, receive a refresh token, and store it. The MindStone service uses the refresh token to get short-lived access tokens automatically — you never need to re-authorize.

### Option A: Node.js Script (Recommended)

This script opens your browser for authorization, then captures and prints the refresh token.

1. Create a new file called `get-gcal-token.js` in any local directory (not inside the MindStone repo):

```javascript
// get-gcal-token.js — run once to get your refresh token
// Usage: GCAL_CLIENT_ID=xxx GCAL_CLIENT_SECRET=yyy node get-gcal-token.js
//
// Requirements: npm install open googleapis

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const open = require('open');

const clientId = process.env.GCAL_CLIENT_ID;
const clientSecret = process.env.GCAL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Error: GCAL_CLIENT_ID and GCAL_CLIENT_SECRET must be set.');
  console.error('Usage: GCAL_CLIENT_ID=xxx GCAL_CLIENT_SECRET=yyy node get-gcal-token.js');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  'http://localhost:3333/oauth2callback'
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar'],
  prompt: 'consent'  // force refresh token even if you previously authorized
});

console.log('Opening browser for Google authorization...');
open(authUrl);

const server = http.createServer(async (req, res) => {
  const qs = url.parse(req.url, true).query;
  if (qs.code) {
    try {
      const { tokens } = await oauth2Client.getToken(qs.code);
      console.log('\n--- Your refresh token ---');
      console.log(tokens.refresh_token);
      console.log('-------------------------');
      console.log('\nCopy the token above to Railway as GCAL_REFRESH_TOKEN');
      res.end('<h1>Done! You can close this tab.</h1>');
      server.close();
    } catch (err) {
      console.error('Failed to get token:', err.message);
      res.end('<h1>Error: ' + err.message + '</h1>');
      server.close();
    }
  }
}).listen(3333, () => {
  console.log('Waiting for authorization on http://localhost:3333 ...');
});
```

2. Install the required dependencies in the same directory:

```bash
npm install open googleapis
```

3. Run the script with your credentials:

```bash
GCAL_CLIENT_ID=your-client-id-here \
GCAL_CLIENT_SECRET=your-client-secret-here \
node get-gcal-token.js
```

4. Your browser will open to Google's authorization page. Sign in with the Google account you added as a test user, then click **Allow**

5. The browser will redirect to `localhost:3333` and the terminal will print your refresh token. Copy it — you will set it as `GCAL_REFRESH_TOKEN` in Section 6.

> **Note:** The script outputs a token that starts with `1//`. If the terminal only shows `null` instead of a token, it means you had previously authorized this app without the `prompt: 'consent'` flag. Delete the app's access at [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions) and run the script again.

---

### Option B: OAuth2 Playground (No Node.js Required)

If you prefer not to run a local script, you can use Google's hosted OAuth2 Playground:

1. Go to [https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
2. Click the settings gear (top right) and check **Use your own OAuth credentials**
3. Enter your `client_id` and `client_secret` from Section 4
4. In the scope list on the left, find and expand **Calendar API v3** and select `https://www.googleapis.com/auth/calendar`
5. Click **Authorize APIs** and sign in with your Google account
6. Click **Exchange authorization code for tokens**
7. Copy the **Refresh token** value from the response panel on the right

---

## Section 6: Set Railway Environment Variables

In the Railway dashboard:

1. Open your MindStone project and click on the **intelligence service**
2. Go to the **Variables** tab
3. Add the following environment variables:

| Variable | Value | Where to find it |
|----------|-------|-----------------|
| `GCAL_CLIENT_ID` | Your client ID | From Section 4 credentials |
| `GCAL_CLIENT_SECRET` | Your client secret | From Section 4 credentials |
| `GCAL_REFRESH_TOKEN` | Your refresh token | From Section 5 |
| `VAULT_TIMEZONE` | Your IANA timezone | See note below |

**Setting `VAULT_TIMEZONE`:** This controls how event times are interpreted. Use an IANA timezone name, for example:
- `America/New_York`
- `America/Los_Angeles`
- `Europe/London`
- `Europe/Berlin`
- `Asia/Tokyo`

For the full list, see the [IANA timezone database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). If you omit this variable, it defaults to UTC.

4. After setting all variables, Railway will automatically redeploy the service. Wait for the deploy to complete before continuing.

> **Note:** Do not set `GCAL_CREDENTIALS_PATH` or `GCAL_TOKEN_PATH` — these are from an older file-based OAuth approach and are not used. MindStone uses env var credentials only.

---

## Section 7: Configure vault/calendars.json

The `calendars.json` file in your vault root maps readable calendar names (used in event files) to Google Calendar IDs.

### Step 1: Find Your Google Calendar ID

1. Open [Google Calendar](https://calendar.google.com)
2. In the left sidebar, hover over the calendar you want to sync
3. Click the three-dot menu → **Settings and sharing**
4. Scroll down to the **Integrate calendar** section
5. Copy the **Calendar ID** value:
   - For your primary personal calendar, it looks like `your-email@gmail.com`
   - For other calendars, it looks like `abc123def456@group.calendar.google.com`

### Step 2: Update calendars.json

1. Open `vault/calendars.json` in your local vault (it was created during the MindStone sync daemon setup)
2. Replace the placeholder calendar ID with your real one:

```json
[
  {"name": "personal", "gcal_id": "your-email@gmail.com"}
]
```

3. To add additional calendars, append more entries to the array:

```json
[
  {"name": "personal", "gcal_id": "your-email@gmail.com"},
  {"name": "work", "gcal_id": "work-calendar-id@group.calendar.google.com"},
  {"name": "family", "gcal_id": "family-calendar-id@group.calendar.google.com"}
]
```

The `name` field is what you use in event files' `calendar:` frontmatter field. It must match exactly (case-sensitive).

4. Save the file — the MindStone sync daemon will detect the change and sync it to Supabase automatically within a few seconds. The intelligence service on Railway reads it from Supabase, so no restart is needed.

> **Important:** The `calendar` field on every event in your vault must exactly match a `name` in this file. If it doesn't match, the event will not sync to GCal and you will see a warning in the service logs.

---

## Section 8: Verify the Setup

Once everything is configured and the Railway deploy has completed, test the integration from Claude:

```
manage_event({
  "action": "create",
  "title": "GCal Integration Test",
  "start_time": "<tomorrow's date in ISO format, e.g. 2026-03-11T14:00:00>",
  "end_time": "<tomorrow's date, e.g. 2026-03-11T15:00:00>",
  "calendar": "personal"
})
```

Then open your Google Calendar. The event should appear within 30 seconds. If it does, the GCal integration is working correctly.

To clean up, delete the test event:
```
manage_event({ "action": "cancel", "title": "GCal Integration Test" })
```

---

## Troubleshooting

**"GCal not configured" in tool response**

One or more of `GCAL_CLIENT_ID`, `GCAL_CLIENT_SECRET`, or `GCAL_REFRESH_TOKEN` is not set in Railway. Verify all three variables are present in the Variables tab and the service has redeployed.

---

**"Calendar not found in calendars.json" in tool response**

The `calendar` field on the event (e.g. `"personal"`) does not match any `name` entry in your `vault/calendars.json`. Check spelling and case — names are case-sensitive.

---

**"calendars.json not found" in service logs**

The file doesn't exist in your vault, or the sync daemon hasn't synced it to Supabase yet. Check that `vault/calendars.json` exists and that the daemon is running. You can verify the daemon is running with `pm2 status` on the machine running the daemon.

---

**"Placeholder gcal_id detected" in service logs**

Your `vault/calendars.json` still contains the placeholder value `YOUR_PERSONAL_CALENDAR_ID@calendar.google.com`. Follow Section 7 to replace it with your real Google Calendar ID.

---

**"invalid_grant" or "Token has been expired or revoked" error**

The refresh token is no longer valid. This can happen if:
- You revoked the app's access at [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions)
- Your OAuth consent screen app was reset

Re-run the token script from Section 5 to get a new refresh token and update the `GCAL_REFRESH_TOKEN` Railway variable.

---

**Event appears in vault but not in Google Calendar**

Check the service logs on Railway for error messages. Common causes:
- The `gcal_id` in `calendars.json` is wrong (copy it directly from Google Calendar settings)
- The Railway service is still deploying — wait for the deploy to finish
- The Google Calendar API is not enabled in your Google Cloud project (Section 2)
