# Connecting Instagram + Facebook to your Social Publish tab

This is a one-time setup so the `vanthara-social` Worker can post to your Facebook Page and Instagram account. It takes about 20 minutes. Free, no ad spend or payment method required.

## Before you start — requirements

- Your Instagram account for Vanthara Homestay must be a **Business** or **Creator** account (not Personal). If it's currently Personal: Instagram app → Settings → Account type and tools → Switch to Professional Account → choose Business.
- Your Instagram account must be **linked to a Facebook Page** you manage (Vanthara Homestay's Page). Do this in Instagram: Settings → Account Center → Connected experiences → link to your Facebook Page. Or in Facebook Page settings → Linked accounts.

## Part 1 — Create the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and log in with the Facebook account that manages your Vanthara Homestay Page.
2. Click **Create App**. Use case: choose **Other** → **Business**. App name: `Vanthara Social`. Associate it with your business portfolio if prompted (or create one — it's free).
3. Once created, you land on the app dashboard.

## Part 2 — Add the Instagram + Facebook products

1. In the left sidebar, find **Add Product**, and add:
   - **Instagram** (choose "Instagram API setup with Instagram Login" is NOT what we want — instead look for **Facebook Login for Business**, which is what powers Page + Instagram Business posting via the Graph API)
   - Actually simplest path: add **Instagram Graph API** if listed, otherwise **Facebook Login for Business**.
2. Go to **App Settings → Basic**. Note your **App ID** and click **Show** next to **App Secret** — copy both somewhere safe for a moment.
3. Still on this page, scroll to **App Domains** and add `vantharahomestay.com`. Under **Privacy Policy URL** you can use `https://vantharahomestay.com`.

## Part 3 — Set the OAuth redirect URI

1. Go to **Facebook Login for Business → Settings** (or **Products → Facebook Login → Settings** depending on what got added).
2. Under **Valid OAuth Redirect URIs**, add (replace `<you>` with your Worker's actual subdomain):
   ```
   https://vanthara-social.<you>.workers.dev/api/oauth/meta/callback
   ```
3. Save changes.

## Part 4 — Add yourself as a tester (avoids Meta's App Review)

Since this app only needs to post to your own Page/Instagram account, keeping the app in **Development mode** and adding yourself as a tester/admin means you can use it immediately without waiting for Meta's App Review process.

1. Go to **App Roles → Roles**. Confirm your Facebook account is listed as **Administrator** (it should be automatically, since you created the app).
2. Go to **App Settings → Basic**, confirm **App Mode** is "Development" (top of the page) — leave it this way.

## Part 5 — Add the credentials to your Worker

1. Go to the Cloudflare dashboard → Workers & Pages → **vanthara-social** → Settings → Variables and Secrets → **Add**.
2. Add these two, alongside your existing ones (add them together in the same panel so nothing gets overwritten):
   - `META_APP_ID` — Type: **Text** — paste the App ID
   - `META_APP_SECRET` — Type: **Secret** — paste the App Secret
3. Click **Deploy**.

## Part 6 — Authorize your Page + Instagram account (one-time)

1. Visit this URL in your browser (replace both placeholders), logged in as the Facebook account that administers your Page:
   ```
   https://vanthara-social.<you>.workers.dev/api/oauth/meta/start?key=YOUR_ADMIN_KEY
   ```
2. Facebook will show a consent screen listing your Page — click **Continue**, then **Allow** for the requested permissions.
3. You'll land on a plain page confirming which Page connected, and whether an Instagram account was found linked to it.

From then on, the Social Publish tab will show Instagram and Facebook as **Connected**, and any approved post with those platforms selected will publish automatically.

### If Instagram doesn't show as connected
This almost always means the Instagram account isn't linked to the Facebook Page yet, or isn't a Business/Creator account. Fix the link (see "Before you start" above), then repeat Part 6 to re-authorize.

### If the connection ever stops working
Facebook Page tokens from this flow don't expire on a fixed schedule but can be revoked if you remove app permissions. If posts start failing, just repeat Part 6 to get a fresh token.
