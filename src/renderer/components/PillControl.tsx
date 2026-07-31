import React from 'react';
import {
  makeStyles,
  tokens,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItemRadio,
  Tooltip,
} from '@fluentui/react-components';
import { ChevronUpRegular } from '@fluentui/react-icons';

/**
 * Google Meet style split control: a chevron that opens a device/source menu,
 * joined to a toggle button that turns the thing on or off. Users who have
 * ever been in a Meet call already know how this works, so there is nothing to
 * learn.
 */

const useStyles = makeStyles({
  pill: {
    display: 'inline-flex',
    alignItems: 'stretch',
    height: '40px',
    borderRadius: '20px',
    overflow: 'hidden',
    background: tokens.colorNeutralBackground4,
  },
  // "off" reads as a warning state, matching Meet's muted-red treatment.
  pillOff: {
    background: tokens.colorPaletteRedBackground3,
  },
  chevron: {
    display: 'grid',
    placeItems: 'center',
    width: '30px',
    border: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    padding: 0,
    ':hover': { background: tokens.colorNeutralBackground4Hover },
  },
  chevronOff: {
    color: '#fff',
    ':hover': { background: 'rgba(255,255,255,0.14)' },
  },
  toggle: {
    display: 'grid',
    placeItems: 'center',
    width: '46px',
    border: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    fontSize: '18px',
    padding: 0,
    ':hover': { background: tokens.colorNeutralBackground4Hover },
  },
  toggleOff: {
    color: '#fff',
    ':hover': { background: 'rgba(255,255,255,0.14)' },
  },
  disabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
    pointerEvents: 'none',
  },
});

export interface PillOption {
  id: string;
  label: string;
}

interface Props {
  /** Icon shown when the control is on. */
  onIcon: React.ReactElement;
  /** Icon shown when the control is off. */
  offIcon: React.ReactElement;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  options: PillOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Menu heading, e.g. "Camera". */
  label: string;
  disabled?: boolean;
  /** Extra items rendered above the option list. */
  children?: React.ReactNode;
}

export function PillControl({
  onIcon,
  offIcon,
  enabled,
  onToggle,
  options,
  selectedId,
  onSelect,
  label,
  disabled,
  children,
}: Props) {
  const s = useStyles();
  const off = !enabled;

  return (
    <div className={`${s.pill} ${off ? s.pillOff : ''} ${disabled ? s.disabled : ''}`}>
      <Menu
        checkedValues={{ [label]: selectedId ? [selectedId] : [] }}
        onCheckedValueChange={(_e, d) => {
          const next = d.checkedItems[0];
          if (next) onSelect(next);
        }}
      >
        <MenuTrigger disableButtonEnhancement>
          <button
            className={`${s.chevron} ${off ? s.chevronOff : ''}`}
            title={`Choose ${label.toLowerCase()}`}
            aria-label={`Choose ${label.toLowerCase()}`}
          >
            <ChevronUpRegular fontSize={16} />
          </button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {children}
            {options.map((o) => (
              <MenuItemRadio key={o.id} name={label} value={o.id}>
                {o.label}
              </MenuItemRadio>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>

      <Tooltip content={`${label}: ${enabled ? 'on' : 'off'}`} relationship="label" withArrow>
        <button
          className={`${s.toggle} ${off ? s.toggleOff : ''}`}
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
        >
          {enabled ? onIcon : offIcon}
        </button>
      </Tooltip>
    </div>
  );
}
