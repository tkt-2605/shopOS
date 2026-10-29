# StoreFront by TRT: Android app

The storefront (`apps/storefront`) in a Capacitor shell. It is the same build as
the website and the installed PWA; the app carries its files, so it opens with no
network and shows the saved catalogue.

Kept outside the npm workspaces, with its own `package.json` and lockfile, so it
never touches the root lockfile.

## Build

```
cd mobile/storefront
npm install
node build-apk.mjs          # release APK, signed: StoreFront.apk
node build-apk.mjs debug    # debug APK: StoreFront-debug.apk
```

`SHOP_API` picks the shop's API (default `https://api-shop.thiruvengadam.me`).
Java comes from Android Studio (`jbr`), the SDK from `%LOCALAPPDATA%\Android\Sdk`.

## What differs from the website

- **Sign-in** goes through the phone's Google account picker
  (`@capgo/capacitor-social-login`), because Google refuses its web button inside
  an app. The token is issued to the same *web* client id, so the till checks it
  as before.
- **Requests** go through Capacitor's native HTTP, so the till's CORS rule (the
  storefront's origin only) does not apply and no till change was needed.
- No service worker.

## Signing and Google

- Release key: `%USERPROFILE%\.shopos\storefront-release.jks`, described by
  `android/keystore.properties` (not committed). Keep a copy somewhere safe: an
  APK signed with another key cannot update the installed app.
- Google Cloud needs an **Android** OAuth client in the same project as the web
  client, with package `me.thiruvengadam.storefront` and the SHA-1 of the key
  that signed the APK:
  - release `8C:3B:42:4A:BD:27:CE:94:8C:D9:6F:63:64:1C:5A:0F:CB:96:B9:28`
  - debug (this PC) `8D:17:56:1A:03:A6:08:28:D4:36:C3:1D:20:67:EF:05:E0:99:D0:FB`
