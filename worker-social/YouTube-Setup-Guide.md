# Connecting YouTube to your Social Publish tab

This is a one-time setup so the `vanthara-social` Worker can upload videos to your YouTube channel on your behalf. It takes about 15 minutes. You'll create a free Google Cloud project — this does not cost anything and doesn't require a credit card for this use.

## Part 1 — Create the Google Cloud project and enable the API

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with the Google account that owns (or manages) your YouTube channel.
2. Click the project dropdown at the top → **New Project**. Name it `Vanthara Social` → **Create**.
3. Once created, make sure it's selected in the project dropdown.
4. Go to **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.

## Part 2 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. User type: **External** → Create.
3. Fill in: App name `Vanthara Social`, User support email (your email), Developer contact email (your email). Leave the rest default → **Save and Continue** through the Scopes step (no changes needed) → **Save and Continue**.
4. On the **Test users** step, click **Add Users** and add your own Google account email (the one that owns the YouTube channel) → **Save and Continue**.
5. Your app will show status "Testing" — that's fine. It means only you (as a test user) can use it, which is exactly what we want since it's just your own channel.

## Part 3 — Create the OAuth Client ID

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**. Name: `Vanthara Social Worker`.
3. Under **Authorized redirect URIs**, click **Add URI** and enter (replace `<you>` with your actual Worker subdomain, visible in the Cloudflare dashboard once the Worker is live):
   ```
   https://vanthara-social.<you>.workers.dev/api/oauth/youtube/callback
   ```
4. Click **Create**. A popup shows your **Client ID** and **Client Secret** — copy both somewhere safe for a moment.

## Part 4 — Add the credentials to your Worker

1. Go to the Cloudflare dashboard → Workers & Pages → **vanthara-social** → Settings → Variables and Secrets → **Add**.
2. Add these two, alongside your existing ones (add them together in the same panel so nothing gets overwritten):
   - `GOOGLE_CLIENT_ID` — Type: **Text** — paste the Client ID
   - `GOOGLE_CLIENT_SECRET` — Type: **Secret** — paste the Client Secret
3. Click **Deploy**.

## Part 5 — Authorize your channel (one-time)

1. Visit this URL in your browser (replace both placeholders):
   ```
   https://vanthara-social.<you>.workers.dev/api/oauth/youtube/start?key=YOUR_ADMIN_KEY
   ```
2. Sign in with the Google account for your channel, and click **Allow** on the consent screen (you may see an "unverified app" warning — click **Advanced → Go to Vanthara Social (unsafe)**; this is expected for apps in Testing mode that only you use).
3. You'll land on a plain page saying "YouTube connected!" — that's it, done.

From then on, the Social Publish tab will show YouTube as **Connected**, and any post you approve with YouTube selected will upload automatically.

### If you ever need to reconnect
If the connection ever stops working, revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) (look for "Vanthara Social"), then repeat Part 5 to get a fresh authorization.
