# Installing Ez Screen Record on macOS

This build is **ad-hoc signed**, not signed with an Apple Developer ID. It runs
fine on any Mac, but macOS adds friction the first time. How much friction
depends entirely on **how the app reached the machine** — pick the first method
you can.

---

## Best: USB stick, file share, or iCloud Drive — zero prompts

Files copied from a USB drive, an external disk, a network share or iCloud Drive
**never get the quarantine flag**, so Gatekeeper is not involved at all.

1. Copy `Ez Screen Record.app` into `/Applications`
2. Double-click it

That is the whole process. No warnings, no Terminal, no admin password.

> AirDrop does **not** count — it flags everything it transfers, including apps.
> Use the next section for AirDrop, Slack, email and downloads.

---

## If it arrived by download, Slack, email or AirDrop

These all attach `com.apple.quarantine`. One Terminal command removes it:

```sh
xattr -cr "/Applications/Ez Screen Record.app"
```

Then open the app normally.

### If you would rather not use Terminal

- **macOS Sonoma (14) and earlier** — right-click the app → **Open** → **Open**.
- **macOS Sequoia (15) and later** — right-click → Open no longer works. Apple
  removed it. Instead:
  1. Double-click the app and let it be blocked
  2. **System Settings → Privacy & Security**
  3. Scroll to the message about *Ez Screen Record* → **Open Anyway**
  4. Enter your admin password

---

## Granting screen recording access

Required once, whichever method you used. macOS will not let any app record the
screen until this is granted.

1. Start a recording — macOS prompts on the first attempt
2. **System Settings → Privacy & Security → Screen & System Audio Recording**
3. Enable **Ez Screen Record**
4. **Quit and reopen the app.** macOS only applies this permission on a fresh
   launch — until you restart it, recording keeps failing with the same error.

Camera and microphone prompt separately the first time you enable them.

---

## Known annoyance: permissions reset when you get a new build

**Every time you install an updated build, you must re-grant Screen Recording.**

This is not a bug in the app. macOS ties the permission to the app's code
signature; an ad-hoc signature has no stable team identity, so macOS falls back
to a hash of the binary — which changes with every rebuild. The new build looks
like a different app.

If the app appears in the Screen Recording list but still cannot record, remove
its entry with the **–** button, then add it again.

The only real fix is an Apple Developer ID certificate ($99/year), which gives a
stable identity that survives updates. Worth it if builds are shared often.

---

## Why the app is not notarized

Notarization requires a paid Apple Developer account. Without it macOS shows the
warnings above. Nothing about the app is unusual — this is what every unsigned
Mac app looks like.

---

## Quality note

macOS recordings use H.264 4:2:0 at a high bitrate. The Windows build records
4:4:4, which keeps small coloured text slightly crisper, but Apple's hardware
encoder (VideoToolbox) has no 4:4:4 mode for H.264. The bitrate is raised to
compensate as far as it can.
