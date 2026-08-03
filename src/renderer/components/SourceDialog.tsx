import React, { useEffect, useMemo, useState } from 'react';
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Text,
  TabList,
  Tab,
  Spinner,
} from '@fluentui/react-components';
import { ArrowSyncRegular, DismissRegular } from '@fluentui/react-icons';
import type { CaptureSource } from '../../shared/types';

/**
 * Visual picker for the capture source. Thumbnails matter here — window titles
 * alone ("C:\WINDOWS\system32\...") tell you very little about which window you
 * are actually about to record.
 */

const useStyles = makeStyles({
  surface: { maxWidth: '760px', width: '90vw' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: '10px',
    maxHeight: '52vh',
    overflowY: 'auto',
    padding: '2px',
  },
  card: {
    border: `2px solid transparent`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    cursor: 'pointer',
    background: tokens.colorNeutralBackground4,
    // A native <button> does not inherit text colour — it falls back to the
    // UA default, which is black. On the dark surface that rendered the window
    // titles as near-invisible black-on-grey, so the colour is set explicitly
    // rather than left to inheritance.
    color: tokens.colorNeutralForeground1,
    padding: 0,
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    // The same applies to the font: a native button uses the system UI font at
    // 13.33px unless told otherwise, which is why these labels did not match
    // the rest of the dialog.
    fontFamily: tokens.fontFamilyBase,
    ':hover': { background: tokens.colorNeutralBackground4Hover },
  },
  cardActive: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
  },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 10',
    objectFit: 'cover',
    display: 'block',
    background: '#000',
  },
  // Same footprint as a thumbnail so the grid stays even.
  minimizedThumb: {
    width: '100%',
    aspectRatio: '16 / 10',
    display: 'grid',
    placeItems: 'center',
    background: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground3,
  },
  label: {
    padding: '6px 8px',
    display: 'block',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  center: { display: 'grid', placeItems: 'center', padding: '40px' },
  permission: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    textAlign: 'center',
    padding: '32px 24px',
    maxWidth: '440px',
    margin: '0 auto',
  },
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: CaptureSource[];
  loading: boolean;
  /**
   * macOS screen-recording permission: 'granted' | 'denied' | 'restricted' |
   * 'not-determined' | 'unknown'. Always 'granted' on Windows. When it is not
   * 'granted' the source list is empty because macOS is blocking enumeration,
   * not because there is nothing to record.
   */
  screenPermission?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  onRefresh: () => void;
}

export function SourceDialog({
  open,
  onOpenChange,
  sources,
  loading,
  screenPermission = 'granted',
  value,
  onChange,
  onRefresh,
}: Props) {
  const s = useStyles();
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  // Only treat permission as the blocker while the list is genuinely empty:
  // if sources came through, capture works and the status is moot.
  const permissionBlocked = screenPermission !== 'granted' && sources.length === 0;

  // Follow the current selection when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const current = sources.find((x) => x.id === value);
    if (current) setTab(current.kind);
  }, [open, value, sources]);

  const filtered = useMemo(() => sources.filter((x) => x.kind === tab), [sources, tab]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => onOpenChange(d.open)}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Choose what to record</DialogTitle>
          <DialogContent>
            {!loading && permissionBlocked ? (
              <div className={s.permission}>
                <Text weight="semibold" size={400}>
                  Screen Recording permission needed
                </Text>
                <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                  macOS is blocking Ez Screen Record from seeing your screens and
                  windows. Enable <b>Ez Screen Record</b> under System Settings ›
                  Privacy &amp; Security › <b>Screen &amp; System Audio Recording</b>,
                  then <b>quit and reopen the app</b> — macOS only applies this
                  permission on a fresh launch.
                </Text>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <Button
                    appearance="primary"
                    onClick={() => void window.ez.permissions.openScreenSettings()}
                  >
                    Open System Settings
                  </Button>
                  <Button
                    appearance="secondary"
                    icon={<ArrowSyncRegular />}
                    onClick={onRefresh}
                  >
                    Refresh
                  </Button>
                </div>
              </div>
            ) : (
              <>
            <div className={s.header}>
              <TabList
                size="small"
                selectedValue={tab}
                onTabSelect={(_e, d) => setTab(d.value as 'screen' | 'window')}
              >
                <Tab value="screen">Screens</Tab>
                <Tab value="window">Windows</Tab>
              </TabList>
              <Button
                size="small"
                appearance="subtle"
                icon={<ArrowSyncRegular />}
                onClick={onRefresh}
              >
                Refresh
              </Button>
            </div>

            {!loading && tab === 'window' && filtered.some((x) => x.minimized) && (
              <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                Minimized windows are listed without a preview. Picking one reopens it,
                since Windows can’t record a minimized window.
              </Text>
            )}

            {loading ? (
              <div className={s.center}>
                <Spinner size="tiny" label="Finding sources…" />
              </div>
            ) : filtered.length === 0 ? (
              <div className={s.center}>
                <Text size={200}>No {tab}s found.</Text>
              </div>
            ) : (
              <div className={s.grid}>
                {filtered.map((src) => (
                  <button
                    key={src.id}
                    className={`${s.card} ${value === src.id ? s.cardActive : ''}`}
                    onClick={() => {
                      onChange(src.id);
                      onOpenChange(false);
                    }}
                    title={src.name}
                  >
                    {/* Minimized windows have no thumbnail — nothing is
                        composited while minimized — so show a placeholder
                        rather than a broken image. */}
                    {src.minimized ? (
                      <div className={s.minimizedThumb}>
                        <Text size={100}>Minimized</Text>
                      </div>
                    ) : (
                      <img className={s.thumb} src={src.thumbnailDataUrl} alt="" />
                    )}
                    <Text className={s.label} size={100}>
                      {src.name}
                    </Text>
                  </button>
                ))}
              </div>
            )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {/* Deselecting is a legitimate action — without it a source, once
                picked, could never be cleared. */}
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              disabled={!value}
              onClick={() => {
                onChange(null);
                onOpenChange(false);
              }}
            >
              Clear selection
            </Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
