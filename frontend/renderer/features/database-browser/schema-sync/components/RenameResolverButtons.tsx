/**
 * `<RenameResolverButtons>` — three-way toggle for object renames.
 *
 * Lets the user pick how a detected rename should be executed:
 *
 *   • **Rename**      — emit the canonical `ALTER ... RENAME TO` statement
 *                       (default behaviour, preserves data).
 *   • **Split**       — drop the old object + create the new one. The
 *                       target's data is destroyed; only the schema side
 *                       of the rename survives.
 *   • **Keep both**   — create the new object, leave the old one alone.
 *                       Useful when the user realises the two objects are
 *                       semantically distinct after all and should coexist.
 *
 * Used for table/view/routine/domain rename rows. Enum **value** renames
 * have their own two-state resolver (accept / split) because "keep both"
 * doesn't make sense for a label inside a single type.
 */

import React from 'react';
import { ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import {
  SwapHoriz as SwapIcon,
  CallSplit as CallSplitIcon,
  ContentCopy as ContentCopyIcon,
} from '@mui/icons-material';
import type { RenameMode } from '../resolveOps';

export interface RenameResolverButtonsProps {
  value: RenameMode;
  onChange: (mode: RenameMode) => void;
  /** Optional label-overrides for the tooltip strings (i18n). */
  labels?: {
    accept?: string;
    split?: string;
    keepBoth?: string;
  };
}

export function RenameResolverButtons({
  value,
  onChange,
  labels,
}: RenameResolverButtonsProps) {
  const l = {
    accept: labels?.accept ?? 'Rename (preserves data)',
    split: labels?.split ?? 'Split into DROP + CREATE (loses target data)',
    keepBoth: labels?.keepBoth ?? 'Keep both (create new, leave old alone)',
  };

  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value}
      onChange={(_, next) => {
        // MUI emits `null` when the active button is clicked again; ignore
        // that — we always want one mode selected.
        if (next) onChange(next as RenameMode);
      }}
      sx={{
        '& .MuiToggleButton-root': {
          px: 1,
          py: 0.25,
          minHeight: 24,
          textTransform: 'none',
          fontSize: '0.65rem',
          fontWeight: 600,
          lineHeight: 1.2,
          gap: 0.5,
        },
      }}
    >
      <Tooltip title={l.accept}>
        <ToggleButton value="accept" color="info">
          <SwapIcon sx={{ fontSize: 14 }} /> Rename
        </ToggleButton>
      </Tooltip>
      <Tooltip title={l.split}>
        <ToggleButton value="split" color="warning">
          <CallSplitIcon sx={{ fontSize: 14 }} /> Split
        </ToggleButton>
      </Tooltip>
      <Tooltip title={l.keepBoth}>
        <ToggleButton value="keep-both" color="success">
          <ContentCopyIcon sx={{ fontSize: 14 }} /> Keep both
        </ToggleButton>
      </Tooltip>
    </ToggleButtonGroup>
  );
}

export default RenameResolverButtons;
