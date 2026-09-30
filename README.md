# latchkey-garmin

A [Latchkey](https://github.com/imbue-ai/latchkey) plugin that
adds Garmin Connect as a service, using the private API the Connect
mobile app talks to (`connectapi.garmin.com`). Use at your own risk.

## Installation

```bash
git clone https://github.com/imbue-ai/latchkey-garmin ~/.latchkey/plugins/garmin
```

Requires Latchkey 3.15.0 or newer.

## Usage

Log in through the browser (email, password, and the MFA code Garmin
sends, if your account has MFA):

```bash
latchkey auth browser garmin
```

Or, if you already have tokens from [garth](https://github.com/matin/garth)
(or anything else that writes its format, such as datalib), import them:

```bash
latchkey auth set-nocurl garmin ~/.garth
```

Then call the API as usual:

```bash
latchkey curl https://connectapi.garmin.com/userprofile-service/socialProfile
```

## How it works

Every call to `connectapi.garmin.com` carries an OAuth2 bearer that
expires after about an hour. A fresh one is minted by an OAuth1-signed
request (HMAC-SHA1), using an OAuth1 token that lasts about a year.
The plugin stores the OAuth1 token in Latchkey's encrypted credential
store, and whenever a request finds the bearer expired, it mints a
new one. When the OAuth1 token itself expires, log in again.

The browser login is the Connect mobile app's own SSO flow: you sign
in on Garmin's mobile sign-in page, the page hands over a service
ticket, and the plugin trades it for the OAuth1 token. The flow and
the pinned OAuth1 consumer both come from garth.

Only `garmin.com` accounts are supported, not `garmin.cn`.

## Development

```bash
npm install
npm run build      # compiles src/ into dist/, which is what Latchkey loads
npm test
npm run lint
```

`dist/` is committed on purpose: Latchkey loads the built JavaScript,
and a plugin has to work straight out of `git clone`. Rebuild and
commit `dist/` together with any change to `src/`.

To try a checkout without cloning it into place, symlink it:

```bash
ln -s "$(pwd)" ~/.latchkey/plugins/garmin
```
