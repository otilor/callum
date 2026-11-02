# Setting up Callum's channels

Each channel is set up once. Do the ones you want and skip the rest. You can come back and add another at any time from Your Callum, under "Where Callum reaches people".

Callum keeps every password, token and cookie on your computer, in its own database. It never shows them again after you save them.

- [Google](#google)
- [Microsoft](#microsoft)
- [LinkedIn](#linkedin)
- [X](#x)
- [Apollo](#apollo)
- [Claude](#claude)

## Google

Callum signs in to your Gmail or Google Workspace mailbox with an app password. This is a separate password that works for one app, and you can delete it whenever you like.

1. Turn on 2-Step Verification for your Google account if it is not on yet: open [myaccount.google.com/security](https://myaccount.google.com/security) and choose 2-Step Verification. Google only offers app passwords once it is on.
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Name it Callum and choose Create.
4. Google shows 16 letters. Copy them.
5. In Callum, choose Email, then Google. Enter your address and paste the app password. Spaces are fine.

If the app passwords page says the setting is not available, one of three things is true: 2-Step Verification is off, your account uses only security keys, or your Google Workspace administrator has turned app passwords off. An administrator can allow them in the Admin console under Security.

To stop Callum using the mailbox, delete the Callum app password on the same Google page.

## Microsoft

Microsoft mail (Outlook.com, Microsoft 365) does not accept app passwords for IMAP and SMTP, so Callum signs in the way Microsoft asks for: you enter a short code on Microsoft's own page and Callum never sees your password.

For that, Callum needs an app registration of your own. It is free, takes about five minutes, and you do it once. It gives you a client ID, which Callum uses to ask Microsoft for permission to read and send on your behalf.

### Register the app

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) with a Microsoft account. A work or school account works if your organisation lets you register apps. A personal account works too: Microsoft will create a free directory for it the first time.
2. In the left menu open Entra ID (Identity), then App registrations, then choose New registration.
3. Name it Callum.
4. Under Supported account types choose "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts". Callum signs in through Microsoft's common endpoint, so this option has to be the one you pick.
5. Leave Redirect URI empty. Callum uses the code sign-in, which does not need one.
6. Choose Register.
7. On the Overview page, copy the Application (client) ID. This is the client ID you give Callum.

### Turn on public client flows

1. In the same app, open Authentication.
2. Open the Settings tab, and under Advanced settings set "Allow public client flows" to Yes.
3. Choose Save.

Without this, Microsoft refuses the code sign-in.

### Add the two permissions

1. Open API permissions and choose Add a permission.
2. Choose the tab "APIs my organization uses", search for Office 365 Exchange Online and open it.
3. Choose Delegated permissions.
4. Tick `IMAP.AccessAsUser.All` and `SMTP.Send`, then choose Add permissions.

`offline_access` (which lets Callum stay signed in) is requested at sign-in and needs no setting here.

If you are the administrator of your organisation, choose "Grant admin consent" on the API permissions page so nobody is asked again. If you are not, you are asked to approve the two permissions the first time you sign in, and in a locked-down organisation an administrator may need to approve them first.

### Give Callum the client ID

- Desktop app: open Your Callum, then Where Callum reaches people, Email, Microsoft setup. Paste the client ID. Callum stores it in its settings.
- Server mode or Docker: set `CALLUM_MICROSOFT_CLIENT_ID` to the client ID and restart Callum.

### Sign in

In Callum choose Email, then Microsoft, and enter your address. Callum shows a code and a link. Open the link, enter the code and approve. Callum waits and connects when you are done.

### If sending fails

Some Microsoft 365 mailboxes have authenticated SMTP switched off. An administrator turns it on for the mailbox in the Microsoft 365 admin center: Users, Active users, the person, Mail, Manage email apps, and tick "Authenticated SMTP".

## LinkedIn

On the desktop app, Callum opens a LinkedIn window and you sign in on LinkedIn's own page, with your own password and any code LinkedIn asks for. Callum never sees your password. It keeps the browser session on this computer, in its own profile folder, so you do not have to sign in again. Callum needs Google Chrome or Microsoft Edge installed. If you have neither, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a Chromium browser.

Before you connect, read the note on LinkedIn in the [README](../README.md#linkedin). Automation is against LinkedIn's terms and your account carries the risk.

### On a server or in Docker

A server has no screen to sign in on. Instead, give Callum your LinkedIn session cookie.

1. Sign in to LinkedIn in a normal browser on your own computer.
2. Open the browser's developer tools. In Chrome and Edge press F12, then open Application. In Firefox open Storage.
3. Under Cookies, choose `https://www.linkedin.com`.
4. Find the cookie named `li_at` and copy its value.
5. In Callum choose LinkedIn, open "Running Callum on a server?", paste the value and choose Use this cookie.

Treat `li_at` like a password: anyone who has it is signed in as you. LinkedIn ends the session now and then, and when it does Callum asks you for a new one. Signing out of LinkedIn in your own browser also ends it, so close that tab rather than signing out.

## X

Sending direct messages on X needs a paid plan on the X API. Prices change, so look at the current plans at [developer.x.com](https://developer.x.com) before you start. If your plan does not include direct messages, Callum says so when you connect.

Callum uses a user access token from OAuth 2.0 with PKCE. X's developer portal does not hand these out directly, so you make one once.

### Make the app

1. Sign in at [developer.x.com](https://developer.x.com) and open the Developer Portal.
2. Create a project and an app inside it.
3. Open the app's User authentication settings and choose Set up.
4. Set App permissions to "Read and write and Direct message".
5. Set Type of App to "Native App" (a public client) or "Web App, Automated App or Bot" (a confidential client). Either works.
6. Enter a Callback URI, for example `http://127.0.0.1:3000/callback`. It only has to match what you use below. Nothing needs to be listening there.
7. Save, then copy the Client ID. For a confidential client also copy the Client Secret.

### Get the token

You need a code verifier and its challenge. Run this on any computer with Node:

```sh
node -e "const c=require('crypto');const v=c.randomBytes(32).toString('base64url');console.log('verifier  '+v);console.log('challenge '+c.createHash('sha256').update(v).digest('base64url'))"
```

Open this address in your browser, with your own Client ID, your callback and the challenge from above:

```
https://x.com/i/oauth2/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcallback&scope=dm.read%20dm.write%20tweet.read%20users.read%20offline.access&state=callum&code_challenge=YOUR_CHALLENGE&code_challenge_method=S256
```

Approve the app. X sends you to your callback address, which shows an error page because nothing is listening there. That is fine. Copy the `code` value from the address bar.

Now trade the code for tokens. The code lasts about 30 seconds, so do this straight away. For a public client:

```sh
curl -X POST https://api.x.com/2/oauth2/token \
  -d grant_type=authorization_code \
  -d client_id=YOUR_CLIENT_ID \
  -d redirect_uri=http://127.0.0.1:3000/callback \
  -d code_verifier=YOUR_VERIFIER \
  -d code=THE_CODE
```

For a confidential client, add `-u YOUR_CLIENT_ID:YOUR_CLIENT_SECRET`.

The answer holds an `access_token` and a `refresh_token`. The `offline.access` scope is what gives you the refresh token.

### Give them to Callum

In Callum choose X and paste the access token. Open "Tokens that refresh themselves" and paste the refresh token and the Client ID (and the Client Secret if you have one). X access tokens last two hours, so without the refresh token Callum stops working that long after you connect. With it, Callum renews the token on its own.

The scopes Callum needs are `dm.read dm.write tweet.read users.read offline.access`.

## Apollo

Apollo lets you describe the people you want to meet ("founders of seed-stage fintechs in Lagos") instead of bringing a list. Without it, Callum still takes a pasted list, a CSV, or a LinkedIn search link.

1. Sign in to [apollo.io](https://www.apollo.io) and open Settings, then Integrations, then API.
2. Create an API key. Use a master key, or allow People Search for it.
3. In Callum choose Add people, then Describe, and paste the key when Callum asks. Or set `APOLLO_API_KEY` on a server.

Searching is free. Adding the people you keep uses Apollo credits, and Callum tells you how many before it spends any.

## Claude

Callum works without a Claude key, using plain templates for hellos, follow-ups and replies. With one, Callum writes in the tone you choose, rewrites your sample hello in place, understands replies in other languages, and drafts answers in the language the person wrote in.

1. Sign in at [console.anthropic.com](https://console.anthropic.com), open API keys and create a key.
2. Set `ANTHROPIC_API_KEY` to the key before Callum starts. On a server or in Docker this goes in the environment or in your `.env` file. For the desktop app, start it from a terminal with the variable set, or set it as a user environment variable for your account.
3. To use another model, set `CALLUM_MODEL`. The default is `claude-opus-5-5`.

If Claude cannot be reached for a message, Callum falls back to its templates for that message and carries on.
