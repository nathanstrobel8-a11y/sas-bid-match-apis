# SAS Bid Match API

This is a small API for a custom GPT Action. It checks the MyBidMatch page, opens the previous day's listing by default, scores solicitations against Superior Access Solutions' capabilities and vendor channels, and returns the best opportunities.

## Run Locally

```bash
npm start
```

The API will run at:

```text
http://localhost:3000
```

Useful URLs:

```text
http://localhost:3000/health
http://localhost:3000/analyze-bids
http://localhost:3000/analyze-bids?date=2026-06-19&top=20
http://localhost:3000/tracked-bids
http://localhost:3000/openapi.yaml
```

## Use With A Custom GPT

1. Host this folder on a public HTTPS service such as Render, Railway, Fly.io, or a small VPS.
2. Make sure the host starts the app with:

```bash
npm start
```

3. After it is hosted, open this URL in your browser and confirm it returns JSON:

```text
https://YOUR-DOMAIN-HERE/health
```

4. Update `openapi.yaml` and replace:

```text
https://YOUR-DOMAIN-HERE
```

with your real hosted API URL.

5. In ChatGPT, open your custom GPT.
6. Click **Configure**.
7. Go to **Actions**.
8. Click **Create new action**.
9. In **Authentication**, choose **None** unless you later add an API key.
10. Import the schema from:

```text
https://YOUR-DOMAIN-HERE/openapi.yaml
```

11. Save the Action.
12. In your GPT instructions, paste this:

```text
Use the SAS Bid Match API to analyze MyBidMatch solicitations.

Default behavior:
- Call analyzeBids with yesterday's date unless I provide a specific date.
- Return the analysis in these sections: Best Solicitations to Chase First, Two I'd Be Careful With, Best Quick Wins, Strong Strategic Pursuits, Do Not Waste Time On These First, and My Final Bid Priority List.
- Keep every opportunity description under 300 characters.
- Show each opportunity's bidId.
- If I say "like", "track", or "save" a bid, call likeBid with that bidId.
- When a bid is liked, show the saved end-user info, due date, SAM.gov link when available, and reminder dates.
- When I ask what we are tracking, call getTrackedBids.
```

13. Test the GPT with:

```text
Analyze Friday, June 19, 2026 and show me the best bids first.
```

14. Then test tracking with:

```text
Like bid <bidId>
```

## What The Scoring Uses

The profile in `data/company-profile.json` was built from your capability statement and vendor list. It rewards solicitations involving:

- Network modernization, integration, communications infrastructure, fiber, wireless, microwave, RF, and private LTE.
- Surveillance, PTZ, video, telemetry, KLV, DTV, imaging, broadcast, cameras, and technical deployment.
- Cybersecurity planning, testing, facility acceptance, installation, training, documentation, procurement, reseller access, and support.
- Known vendor or brand channels from your vendor list and capability statement.

Each returned opportunity includes a score, win-chance label, reasons, risks, URL, and a `description` capped at 300 characters.

The response also includes an `analysis` section with:

- Best solicitations to chase first
- Bids to be careful with
- Best quick wins
- Strong strategic pursuits
- Do-not-waste-time-first items
- Final bid priority list

## Like And Track A Bid

When your GPT shows a bid you want to chase, tell it to like/track the bid. It should call:

```text
POST /like-bid
```

Example body:

```json
{
  "bidId": "abc123example",
  "notes": "Good PTZ camera fit"
}
```

The API saves the bid in `data/memory.json`, stores end-user details found in the solicitation, and creates reminder dates for:

- 1 week before due
- 3 days before due
- 1 day before due

View tracked bids:

```text
GET /tracked-bids
```

Custom GPTs do not support a true visual like button inside the chat UI. The practical version is: have the GPT show each bid with its `bidId`, then use a prompt like `Like bid <bidId>` or `Track bid <bidId>`.

## Send Liked Bids To Zoho CRM

Use Zoho Flow as the bridge between this API and Zoho CRM.

1. Open Zoho Flow.
2. Create a new flow.
3. Choose **Webhook** as the trigger.
4. Copy the webhook URL Zoho gives you.
5. Add an action: **Zoho CRM - Create Deal**.
6. Map these incoming fields from the webhook payload:

```text
dealName
stage
source
bidId
solicitationNumber
solicitationTitle
solicitationUrl
samUrl
dueDate
setAside
score
winChance
endUser.email
endUser.title
endUser.firstName
endUser.lastName
endUser.phone
billingAddress.street
billingAddress.city
billingAddress.state
billingAddress.postalCode
shippingAddress.street
shippingAddress.city
shippingAddress.state
shippingAddress.postalCode
```

7. Optional but recommended: add Zoho CRM task actions using the `reminders` array for:
   - 1 week before due
   - 3 days before due
   - 1 day before due

8. In Render, open this API service.
9. Go to **Environment**.
10. Add this environment variable:

```text
ZOHO_FLOW_WEBHOOK_URL=PASTE_YOUR_ZOHO_FLOW_WEBHOOK_URL_HERE
```

11. Redeploy the Render service.

After that, whenever you tell the GPT `Like bid <bidId>`, the API will:

- Save the bid in memory.
- Extract the end user.
- Extract email, first name, last name, phone, billing address, and shipping address when available.
- Send a Zoho-ready Deal payload to Zoho Flow.
- Return the Zoho sync status.

## Environment Variables

```text
PORT=3000
MYBIDMATCH_URL=https://mybidmatch.outreachsystems.com/go?sub=4C27AA86-1FA5-4B03-BD02-6FFE6148C080
ZOHO_FLOW_WEBHOOK_URL=
```
