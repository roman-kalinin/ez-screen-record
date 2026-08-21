import React from 'react';
import { Switch, Text, tokens } from '@fluentui/react-components';
import type { AppSettings, ShareSettings as ShareSettingsType } from '../../shared/types';

/**
 * The one-click share section of the settings dialog.
 *
 * Deliberately tiny: GoFile needs no account and no key, so there is nothing to
 * connect or configure. A single switch enables auto-upload of finished
 * recordings; the link is copied to the clipboard on success.
 */
export function ShareSettings({
  share,
  setSettings,
}: {
  share: ShareSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}) {
  return (
    <>
      <Text size={200} weight="semibold">
        Share link
      </Text>

      <Switch
        checked={share.autoUpload}
        label="Auto-upload &amp; copy share link"
        onChange={(_e, d) =>
          setSettings((p) => ({ ...p, share: { ...p.share, autoUpload: d.checked } }))
        }
      />

      <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
        Uploads to GoFile — no account or sign-in needed. The link is copied for you; it stays
        live while it&apos;s being viewed (about 10 days of no activity).
      </Text>
    </>
  );
}
