import React, { useEffect, useState } from 'react';
import {
  makeStyles,
  mergeClasses,
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Dropdown,
  Option,
  Switch,
  ProgressBar,
  Link,
  Tooltip,
} from '@fluentui/react-components';
import {
  DismissRegular,
  SparkleRegular,
  ResizeVideoRegular,
  Speaker2Regular,
  SpeakerMuteRegular,
  FolderOpenRegular,
  DocumentRegular,
  CloudArrowUpRegular,
  CheckmarkCircleFilled,
  CopyRegular,
  ErrorCircleRegular,
} from '@fluentui/react-icons';
import type {
  EditorExportProgress,
  EditorExportResult,
  EditorQuality,
  EditorResolution,
  EditorSession,
} from '../../shared/types';
import { fmtBytes, fmtLength } from './model';
import { ed } from './theme';

const useStyles = makeStyles({
  surface: {
    width: '520px',
    maxWidth: 'calc(100vw - 48px)',
    padding: '22px 22px 18px',
    borderRadius: '14px',
    background: '#1c1a18',
    border: `1px solid ${ed.hairlineStrong}`,
    boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
  },
  title: {
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
    fontSize: '18px',
    lineHeight: '24px',
    fontWeight: 600,
    color: ed.ink1,
  },
  sub: { marginTop: '2px', fontSize: '13px', color: ed.ink3, fontVariantNumeric: 'tabular-nums' },
  content: { display: 'flex', flexDirection: 'column', gap: '14px', paddingTop: '14px' },
  group: {
    borderRadius: '12px',
    background: ed.surface,
    border: `1px solid ${ed.hairline}`,
    padding: '0 14px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    minHeight: '60px',
    padding: '10px 0',
  },
  rowDivider: { borderTop: `1px dashed ${ed.hairlineStrong}` },
  tile: {
    flexShrink: 0,
    width: '32px',
    height: '32px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: ed.fillMed,
    color: ed.ink2,
    fontSize: '17px',
  },
  rowText: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
  rowTitle: { fontSize: '13px', lineHeight: '18px', fontWeight: 500, color: ed.ink1 },
  rowDesc: {
    fontSize: '12px',
    lineHeight: '16px',
    color: ed.ink3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  control: { flexShrink: 0 },
  dropdown: { minWidth: '150px' },
  actions: { paddingTop: '18px' },
  progressBlock: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '18px 16px' },
  progressTop: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: ed.ink2 },
  pctText: { fontVariantNumeric: 'tabular-nums', color: ed.ink1, fontWeight: 500 },
  muted: { fontSize: '12px', color: ed.ink3 },
  doneHead: { display: 'flex', alignItems: 'center', gap: '10px' },
  doneIcon: { color: '#58c08a', fontSize: '22px' },
  errorText: {
    fontSize: '12px',
    lineHeight: '17px',
    color: '#f0a090',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '120px',
    overflowY: 'auto',
  },
  link: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' },
});

const QUALITY: Array<{ value: EditorQuality; label: string; detail: string }> = [
  { value: 'high', label: 'High', detail: 'Near-lossless. Largest file.' },
  { value: 'balanced', label: 'Balanced', detail: 'Sharp text, sensible size.' },
  { value: 'small', label: 'Small', detail: 'Most compression, for quick sharing.' },
];

const PREFS_KEY = 'ez-editor-export-v1';
interface Prefs {
  quality: EditorQuality;
  resolution: EditorResolution;
  keepAudio: boolean;
}
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      quality: ['high', 'balanced', 'small'].includes(p.quality) ? p.quality : 'balanced',
      resolution: ['source', '1080', '720', '480'].includes(p.resolution) ? p.resolution : 'source',
      keepAudio: p.keepAudio !== false,
    };
  } catch {
    return { quality: 'balanced', resolution: 'source', keepAudio: true };
  }
}

function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}
function dirname(p: string) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

function Row(props: { icon: React.ReactNode; title: string; desc?: React.ReactNode; first?: boolean; children?: React.ReactNode }) {
  const s = useStyles();
  return (
    <div className={mergeClasses(s.row, !props.first && s.rowDivider)}>
      <div className={s.tile}>{props.icon}</div>
      <div className={s.rowText}>
        <div className={s.rowTitle}>{props.title}</div>
        {props.desc != null && <div className={s.rowDesc}>{props.desc}</div>}
      </div>
      <div className={s.control}>{props.children}</div>
    </div>
  );
}

type Phase =
  | { kind: 'settings'; note?: string }
  | { kind: 'exporting'; progress: EditorExportProgress | null }
  | { kind: 'done'; result: EditorExportResult }
  | { kind: 'error'; message: string };

type Share =
  | { kind: 'idle' }
  | { kind: 'uploading'; fraction: number }
  | { kind: 'done'; url: string; copied: boolean }
  | { kind: 'error'; message: string };

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  session: EditorSession;
  keep: Array<[number, number]>;
  cutCount: number;
  /** Fired after a successful export, with the cuts that produced it. */
  onExported: () => void;
}

const ENCODER_NAMES: Record<string, string> = {
  h264_nvenc: 'NVIDIA GPU',
  h264_amf: 'AMD GPU',
  h264_qsv: 'Intel GPU',
  h264_videotoolbox: 'Apple media engine',
  libx264: 'CPU',
};

export function ExportDialog(p: ExportDialogProps) {
  const s = useStyles();
  const info = p.session.info;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [output, setOutput] = useState(p.session.defaultOutputPath);
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' });
  const [share, setShare] = useState<Share>({ kind: 'idle' });

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);

  // Reset to the settings view each time the dialog opens, with a fresh
  // never-existing default name after a previous export.
  useEffect(() => {
    if (!p.open) return;
    setPhase((ph) => (ph.kind === 'exporting' ? ph : { kind: 'settings' }));
    setShare({ kind: 'idle' });
    void window.ez.editor.session().then((sess) => {
      if (sess) setOutput((cur) => (cur === p.session.defaultOutputPath || !cur ? sess.defaultOutputPath : cur));
    });
  }, [p.open]);

  useEffect(
    () =>
      window.ez.on('editor:exportProgress', (pr: EditorExportProgress) =>
        setPhase((ph) => (ph.kind === 'exporting' ? { kind: 'exporting', progress: pr } : ph)),
      ),
    [],
  );
  useEffect(
    () =>
      window.ez.on('share:uploadProgress', (u: { uploaded: number; total: number; phase: string }) => {
        if (u.phase !== 'uploading' && u.phase !== 'starting') return;
        setShare((sh) =>
          sh.kind === 'uploading' ? { kind: 'uploading', fraction: u.total ? u.uploaded / u.total : 0 } : sh,
        );
      }),
    [],
  );

  const total = p.keep.reduce((a, [st, en]) => a + (en - st), 0);
  const srcH = info?.height ?? 0;
  const resolutions: Array<{ value: EditorResolution; label: string }> = [
    { value: 'source', label: info ? `Original · ${info.width}×${info.height}` : 'Original' },
    ...(['1080', '720', '480'] as const)
      .filter((h) => Number(h) < srcH)
      .map((h) => ({ value: h as EditorResolution, label: `${h}p` })),
  ];
  const resolution = resolutions.some((r) => r.value === prefs.resolution) ? prefs.resolution : 'source';
  const hasAudio = info?.hasAudio ?? false;
  const keepAudio = hasAudio && prefs.keepAudio;

  const start = async () => {
    setPhase({ kind: 'exporting', progress: null });
    const res = await window.ez.editor.export({
      keep: p.keep,
      keepAudio,
      quality: prefs.quality,
      resolution,
      outputPath: output,
    });
    if (res.ok) {
      setPhase({ kind: 'done', result: res });
      p.onExported();
    } else if (res.cancelled) {
      setPhase({ kind: 'settings', note: 'Export cancelled.' });
    } else {
      setPhase({ kind: 'error', message: res.error || 'Export failed.' });
    }
  };

  const changeOutput = async () => {
    const r = await window.ez.editor.chooseOutput(output);
    if (!r) return;
    if (r.error) setPhase({ kind: 'settings', note: r.error });
    else if (r.path) setOutput(r.path);
  };

  const upload = async (file: string) => {
    setShare({ kind: 'uploading', fraction: 0 });
    const r = await window.ez.share.upload(file);
    if (r.ok && r.viewUrl) setShare({ kind: 'done', url: r.viewUrl, copied: true });
    else setShare({ kind: 'error', message: r.error || 'Upload failed.' });
  };

  const busy = phase.kind === 'exporting';
  const close = () => {
    if (!busy) p.onClose();
  };

  let title = 'Export video';
  let sub = `${fmtLength(total)} final length · ${p.cutCount === 0 ? 'no cuts' : `${p.cutCount} cut${p.cutCount === 1 ? '' : 's'} removed`}`;
  if (phase.kind === 'exporting') title = 'Exporting…';
  if (phase.kind === 'done') title = 'Your video is ready';
  if (phase.kind === 'error') title = 'Export failed';

  return (
    <Dialog open={p.open} onOpenChange={(_e, d) => !d.open && close()}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={
              <Button appearance="subtle" icon={<DismissRegular />} aria-label="Close" disabled={busy} onClick={close} />
            }
          >
            <div className={s.title}>{title}</div>
            <div className={s.sub}>{sub}</div>
          </DialogTitle>

          <DialogContent className={s.content}>
            {phase.kind === 'settings' && (
              <div className={s.group}>
                <Row first icon={<SparkleRegular />} title="Quality" desc={QUALITY.find((q) => q.value === prefs.quality)?.detail}>
                  <Dropdown
                    className={s.dropdown}
                    size="small"
                    value={QUALITY.find((q) => q.value === prefs.quality)?.label}
                    selectedOptions={[prefs.quality]}
                    onOptionSelect={(_e, d) => setPrefs((x) => ({ ...x, quality: d.optionValue as EditorQuality }))}
                  >
                    {QUALITY.map((q) => (
                      <Option key={q.value} value={q.value}>
                        {q.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Row>
                <Row
                  icon={<ResizeVideoRegular />}
                  title="Resolution"
                  desc={resolution === 'source' ? 'Same size as the recording.' : 'Scaled down in the same pass.'}
                >
                  <Dropdown
                    className={s.dropdown}
                    size="small"
                    value={resolutions.find((r) => r.value === resolution)?.label}
                    selectedOptions={[resolution]}
                    onOptionSelect={(_e, d) => setPrefs((x) => ({ ...x, resolution: d.optionValue as EditorResolution }))}
                  >
                    {resolutions.map((r) => (
                      <Option key={r.value} value={r.value}>
                        {r.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Row>
                <Row
                  icon={keepAudio ? <Speaker2Regular /> : <SpeakerMuteRegular />}
                  title="Audio"
                  desc={!hasAudio ? 'This recording has no audio track.' : keepAudio ? 'Kept, in sync with the picture.' : 'Exported silent.'}
                >
                  <Switch
                    checked={keepAudio}
                    disabled={!hasAudio}
                    onChange={(_e, d) => setPrefs((x) => ({ ...x, keepAudio: d.checked }))}
                    aria-label="Keep audio"
                  />
                </Row>
                <Row icon={<DocumentRegular />} title={basename(output)} desc={dirname(output)}>
                  <Button size="small" appearance="subtle" onClick={changeOutput}>
                    Change…
                  </Button>
                </Row>
              </div>
            )}

            {phase.kind === 'settings' && phase.note && <div className={s.muted}>{phase.note}</div>}

            {phase.kind === 'exporting' && (
              <div className={s.group}>
                <div className={s.progressBlock}>
                  <div className={s.progressTop}>
                    <span>
                      {!phase.progress || phase.progress.phase === 'preparing'
                        ? 'Preparing…'
                        : phase.progress.phase === 'joining'
                          ? 'Finishing up…'
                          : `Encoding on ${ENCODER_NAMES[phase.progress.encoder ?? ''] ?? phase.progress.encoder}`}
                    </span>
                    <span className={s.pctText}>{Math.round((phase.progress?.fraction ?? 0) * 100)}%</span>
                  </div>
                  <ProgressBar
                    value={phase.progress && phase.progress.phase !== 'preparing' ? phase.progress.fraction : undefined}
                    max={1}
                    thickness="large"
                  />
                  <div className={s.muted}>
                    {basename(output)}
                    {phase.progress?.speed && phase.progress.speed !== 'N/A' ? ` · ${phase.progress.speed} realtime` : ''}
                  </div>
                </div>
              </div>
            )}

            {phase.kind === 'done' && phase.result.outputPath && (
              <>
                <div className={s.group}>
                  <Row
                    first
                    icon={<CheckmarkCircleFilled className={s.doneIcon} />}
                    title={basename(phase.result.outputPath)}
                    desc={`${fmtLength(total)} · ${fmtBytes(phase.result.sizeBytes ?? 0)} · saved next to the original`}
                  >
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<FolderOpenRegular />}
                      onClick={() => window.ez.revealFile(phase.result.outputPath!)}
                    >
                      Show in folder
                    </Button>
                  </Row>
                  <Row
                    icon={<CloudArrowUpRegular />}
                    title="Share link"
                    desc={
                      share.kind === 'idle' ? (
                        'Upload to GoFile and copy a link anyone can open.'
                      ) : share.kind === 'uploading' ? (
                        <ProgressBar value={share.fraction} max={1} style={{ marginTop: 6, width: 220 }} />
                      ) : share.kind === 'done' ? (
                        <Link className={s.link} href={share.url} target="_blank" rel="noreferrer">
                          {share.url}
                        </Link>
                      ) : (
                        share.message
                      )
                    }
                  >
                    {share.kind === 'idle' || share.kind === 'error' ? (
                      <Button size="small" appearance="subtle" onClick={() => void upload(phase.result.outputPath!)}>
                        {share.kind === 'error' ? 'Retry' : 'Upload'}
                      </Button>
                    ) : share.kind === 'done' ? (
                      <Tooltip content={share.copied ? 'Copied' : 'Copy link'} relationship="label">
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<CopyRegular />}
                          onClick={() => {
                            void navigator.clipboard.writeText(share.url);
                            setShare({ ...share, copied: true });
                          }}
                        >
                          {share.copied ? 'Copied' : 'Copy'}
                        </Button>
                      </Tooltip>
                    ) : null}
                  </Row>
                </div>
              </>
            )}

            {phase.kind === 'error' && (
              <div className={s.group}>
                <Row first icon={<ErrorCircleRegular />} title="ffmpeg could not finish the export" desc="The original recording is untouched.">
                  {null}
                </Row>
                <div className={s.errorText} style={{ paddingBottom: 12 }}>
                  {phase.message}
                </div>
              </div>
            )}
          </DialogContent>

          <DialogActions className={s.actions}>
            {phase.kind === 'settings' && (
              <>
                <Button appearance="subtle" onClick={close}>
                  Cancel
                </Button>
                <Button appearance="primary" onClick={() => void start()} disabled={!info || total <= 0}>
                  Export
                </Button>
              </>
            )}
            {phase.kind === 'exporting' && (
              <Button appearance="subtle" onClick={() => void window.ez.editor.cancelExport()}>
                Cancel export
              </Button>
            )}
            {phase.kind === 'done' && (
              <Button appearance="primary" onClick={close}>
                Done
              </Button>
            )}
            {phase.kind === 'error' && (
              <>
                <Button appearance="subtle" onClick={close}>
                  Close
                </Button>
                <Button appearance="primary" onClick={() => setPhase({ kind: 'settings' })}>
                  Back to settings
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
