import React from 'react';
import { Field, Input, Switch, Text, tokens } from '@fluentui/react-components';
import type { AppSettings, ShareSettings as ShareSettingsType } from '../../shared/types';

/**
 * The one-click share section of the settings dialog.
 *
 * Deliberately tiny: pixeldrain needs no account, so there is nothing to
 * connect. An optional API key raises the upload limits, and a switch enables
 * auto-upload of finished recordings.
 */
export function ShareSettings({
  share,
  setSettings,
  notify,
}: {
  share: ShareSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  notify: (
    title: string,
    body?: string,
    intent?: 'success' | 'error' | 'warning',
  ) => void;
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

      <Field label="pixeldrain API key (optional)">
        <Input
          type="password"
          size="small"
          value={share.pixeldrainApiKey ?? ''}
          placeholder="Anonymous — no key needed"
          onChange={(_e, d) =>
            setSettings((p) => ({
              ...p,
              // Empty input means anonymous, stored as null rather than "".
              share: { ...p.share, pixeldrainApiKey: d.value.trim() ? d.value : null },
            }))
          }
        />
      </Field>

      <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
        Uploads to pixeldrain — no account needed. Links stay live ~60 days. Add an optional API
        key for higher limits.
      </Text>
    </>
  );
}
