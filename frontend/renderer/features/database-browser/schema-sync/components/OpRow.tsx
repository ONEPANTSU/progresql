/**
 * `<OpRow>` — unified row primitive for Schema Sync.
 *
 * A single selectable operation row used by every section. The row renders:
 *
 *   [checkbox] [kindIcon] [qualified name] [CHIP]   [meta] [warning] [▾]
 *   └─ optional inline `extras` (rename resolver, drop-value picker, …)
 *   └─ optional `sql` preview, shown only after the user expands the row
 *
 * Design decisions:
 *   - **Selection and SQL-preview are two independent states.** The
 *     checkbox drives "include in migration"; the expand caret (▾) drives
 *     "show me the SQL". Initially after Compare the modal pre-selects all
 *     non-destructive ops — we don't want every SQL block to flash open at
 *     the same time, so `sqlExpanded` starts `false` regardless of
 *     selection.
 *   - Clicking anywhere on the row *except* the checkbox / extras / pre
 *     block / expand button toggles the SQL preview. That's the most
 *     common reason a user wants to interact with a row ("show me what
 *     this op actually runs"), so it's the bare-row click target.
 *   - Supports a `warning` string for one-line amber hints (used by
 *     view.forceRecreate, trigger.replace, etc.) without needing the
 *     caller to build another `<Typography>` by hand.
 */

import React, { useCallback, useState } from 'react';
import { Box, Checkbox, Chip, Typography, Tooltip, IconButton } from '@mui/material';
import {
  Warning as WarningIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';

export interface OpRowProps {
  /** Unique op id — only used for the React key in the parent; pass for clarity. */
  id?: string;
  /** Selected state. */
  selected: boolean;
  /** Toggle callback. */
  onToggle: () => void;
  /** Small leading icon before the chip (e.g. `<AddIcon />`). */
  kindIcon?: React.ReactNode;
  /** Chip label, e.g. "CREATE VIEW". */
  chipLabel: string;
  /** Chip color. */
  chipColor: 'success' | 'error' | 'warning' | 'info';
  /** Main name text, typically a schema-qualified identifier. */
  name: string;
  /** Optional trailing metadata text (greyed out). */
  meta?: string;
  /** Amber hint text shown below the main row when present. */
  warning?: string;
  /** Destructive flag — shows a red warning icon in the row header. */
  isDestructive?: boolean;
  /** Tooltip text for the destructive warning icon. */
  destructiveTooltip?: string;
  /** Extra inline controls always visible (rename resolver buttons, …). */
  extras?: React.ReactNode;
  /** Extra content shown only when the row is expanded (value changes, …). */
  collapsedExtras?: React.ReactNode;
  /** SQL preview text, shown as a monospace code block when selected. */
  sql?: string;
  /** Max height of the SQL preview in pixels. Defaults to 200. */
  sqlMaxHeight?: number;
}

export function OpRow({
  selected,
  onToggle,
  kindIcon,
  chipLabel,
  chipColor,
  name,
  meta,
  warning,
  isDestructive = false,
  destructiveTooltip = 'Destructive operation — review carefully',
  extras,
  collapsedExtras,
  sql,
  sqlMaxHeight = 200,
}: OpRowProps) {
  // SQL preview collapse state is per-row and independent of `selected`.
  // Users explicitly asked that pre-selected non-destructive ops don't all
  // flash their SQL open when the modal loads.
  const [sqlExpanded, setSqlExpanded] = useState(false);

  const handleRowClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Clicks on the checkbox / extras / pre block / expand button have
      // their own handlers; only bare row clicks toggle the SQL preview.
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'input,button,select,.MuiSelect-root,.MuiSelect-select,.MuiMenuItem-root,.MuiToggleButton-root,pre,[data-op-extras],[data-op-expand]',
        )
      ) {
        return;
      }
      if (sql || collapsedExtras) setSqlExpanded((prev) => !prev);
    },
    [sql, collapsedExtras],
  );

  return (
    <Box
      onClick={handleRowClick}
      sx={{
        p: 0.75,
        mb: 0.5,
        borderRadius: 1,
        border: 1,
        // Only `selected` drives the border colour. Destructive rows are
        // indicated solely by the ⚠ warning icon in the header — the
        // previous amber border tint made the list noisy.
        borderColor: 'divider',
        bgcolor: 'transparent',
        cursor: 'pointer',
        transition: 'border-color 0.12s',
        '&:hover': {
          borderColor: 'text.secondary',
        },
      }}
    >
      {/* Header row -------------------------------------------------------- */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 24 }}>
        <Checkbox
          size="small"
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          sx={{ p: 0 }}
        />
        {kindIcon}
        <Typography
          variant="caption"
          sx={{
            fontFamily: 'monospace',
            fontSize: '0.72rem',
            flexGrow: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </Typography>
        <Chip
          label={chipLabel}
          size="small"
          color={chipColor}
          variant="outlined"
          sx={{ height: 18, fontSize: '0.6rem', fontWeight: 700 }}
        />
        {meta && (
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem', mr: 0.5 }}>
            {meta}
          </Typography>
        )}
        {isDestructive && (
          <Tooltip title={destructiveTooltip}>
            <WarningIcon sx={{ fontSize: 14, color: 'warning.main' }} />
          </Tooltip>
        )}
        {(sql || collapsedExtras) && (
          <IconButton
            size="small"
            data-op-expand
            onClick={(e) => {
              e.stopPropagation();
              setSqlExpanded((prev) => !prev);
            }}
            sx={{
              p: 0.25,
              ml: 0.25,
              transform: sqlExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.18s',
            }}
            title={sqlExpanded ? 'Hide SQL preview' : 'Show SQL preview'}
          >
            <ExpandMoreIcon sx={{ fontSize: 16 }} />
          </IconButton>
        )}
      </Box>

      {/* Optional warning hint -------------------------------------------- */}
      {warning && (
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mt: 0.25,
            color: 'warning.dark',
            fontSize: '0.65rem',
          }}
        >
          {warning}
        </Typography>
      )}

      {/* Optional extra controls (rename resolver / drop picker / …) ------ */}
      {extras && (
        <Box data-op-extras sx={{ mt: 0.5 }} onClick={(e) => e.stopPropagation()}>
          {extras}
        </Box>
      )}

      {/* Collapsed extras (value changes, etc.) — shown only when expanded */}
      {sqlExpanded && collapsedExtras && (
        <Box data-op-extras sx={{ mt: 0.5 }} onClick={(e) => e.stopPropagation()}>
          {collapsedExtras}
        </Box>
      )}

      {/* SQL preview ------------------------------------------------------- */}
      {sqlExpanded && sql && (
        <Box
          component="pre"
          sx={{
            m: 0,
            mt: 0.75,
            p: 0.75,
            bgcolor: 'action.hover',
            borderRadius: 1,
            fontSize: '0.68rem',
            fontFamily: 'monospace',
            overflow: 'auto',
            maxHeight: sqlMaxHeight,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {sql}
        </Box>
      )}
    </Box>
  );
}

export default OpRow;
