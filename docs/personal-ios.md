# Personal iOS builds

This branch combines `feat/pi-family-sessions` (upstream PR #150) and
`feat/tailscale-check-auth`. Keep feature changes on those branches, then merge
them here. Do not use this combined branch for an upstream feature PR.

The installed app is **HerdrChat Personal**, bundle ID
`dev.awlaursen.herdrchat`. Its URL scheme is `herdrchat-personal`. It can coexist
with the App Store app and has separate hosts, secrets and local history. The
native project name remains HerdrChat for compatibility with the existing
build scripts.

## Build and install from Linux, macOS or Windows

A paid Apple Developer account and an Expo account are required for this ad hoc
route. EAS builds on a cloud Mac; no local Mac or Metro server is required.

```sh
git switch personal/ios
npm ci
npx eas-cli@latest login
npx eas-cli@latest init
npx eas-cli@latest device:create
npx eas-cli@latest build --platform ios --profile personal-ios
```

Use the device-registration link on the iPhone you will install on. During the
build, select your own Apple team and that registered device. EAS manages the
signing credentials interactively. After the build completes, open its install
link on that iPhone. Register a new device before building for it.

`eas init` links this checkout to your Expo project. Commit the project ID it
adds on this branch only; do not copy an upstream EAS project ID. The build
number is managed remotely by EAS. Credentials and Apple API keys do not belong
in git.

## Optional TestFlight

Create your own App Store Connect record for `dev.awlaursen.herdrchat`, then:

```sh
npx eas-cli@latest build --platform ios --profile personal-testflight
npx eas-cli@latest submit --platform ios
```

Select the store build when prompted. This uploads to your own App Store Connect
app; it does not publish to the App Store. Add yourself as an internal tester.
The native SSH change requires a full build, not an Expo Go or JS-only update.

## Connect and check the combined features

1. Connect the iPhone's Tailscale app to your tailnet.
2. Add the host and username; select **Tailscale SSH** and test the connection.
3. When check mode prompts, approve in the browser. Test cancellation as well.
4. Save the host, open a Pi chat and verify both history and a new reply.
5. After the check period expires, verify approval works again on reconnect.

The Demo phrase `show ssh approval` previews the approval dialog without a
server. It is not proof of a live Tailscale login. Native CI covers the SSH
protocol against a fixture; final browser/background/device acceptance still
needs an iPhone.

## Notifications

The upstream push relay cannot sign notifications for this separate Apple team
and bundle ID. Leave notifications off until you configure your own APNs key,
as described in the main setup guide. In direct mode also set
`APNS_BUNDLE_ID=dev.awlaursen.herdrchat` in the host's APNs environment, with the
correct sandbox/production environment for the provisioning profile.

## Keep it current

```sh
git fetch upstream
git fetch origin
git switch personal/ios
git merge upstream/main
git merge origin/feat/pi-family-sessions
git merge origin/feat/tailscale-check-auth
```

After a feature is merged upstream, its upstream implementation becomes the
source of truth. Resolve any squash-merge overlap here while leaving unrelated
feature PRs independent. Rebuild the native app after SSH module changes.
