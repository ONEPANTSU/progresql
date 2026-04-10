/**
 * `<OpSection>` — unified collapsible section header for Schema Sync.
 *
 * Replaces the 7 different bespoke section blocks in `SchemaSyncModal.tsx`
 * (Enums / Views / Routines / Sequences / Triggers / Domains / Tables) with
 * a single primitive that:
 *
 *   - shows an icon + uppercase title + `(count)` suffix
 *   - carries a **tri-state section checkbox** for select-all / none /
 *     indeterminate on the header itself (not hidden behind an expand)
 *   - collapses its children via a click on the header (or the caret)
 *   - renders a warning badge when the section contains destructive ops
 *
 * The children prop receives whatever rows / groups the specific section
 * wants to render — usually a list of `<OpRow>`s or nested `<Accordion>`s.
 */

import React, { useState, useCallback } from 'react';
import { Box, Typography, Checkbox, IconButton, Collapse, Tooltip, Chip } from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';

export interface OpSectionProps {
  /** Uppercase section title, e.g. "Tables", "Enums". */
  title: string;
  /** Icon shown to the left of the title (14px by convention). */
  icon: React.ReactNode;
  /** Total number of rows/ops in the section. Shown as "(count)". */
  count: number;
  /** How many of those are currently selected. Drives the tri-state checkbox. */
  selectedCount: number;
  /** Toggle-all callback; fires when the header checkbox is clicked. */
  onToggleAll: () => void;
  /** When true, a small amber warning icon appears next to the title. */
  hasDestructive?: boolean;
  /**
   * Initial expanded state. Defaults to `true` so users see the diff
   * sections immediately on open. Individual nested blocks (per-enum /
   * per-table accordions) are collapsed by default so the modal isn't
   * overwhelming even when there are many ops.
   */
  defaultExpanded?: boolean;
  /** Optional tooltip text shown on hover of the destructive warning icon. */
  destructiveTooltip?: string;
  /** Section body — rows, accordions, or arbitrary JSX. */
  children: React.ReactNode;
}

export function OpSection({
  title,
  icon,
  count,
  selectedCount,
  onToggleAll,
  hasDestructive = false,
  defaultExpanded = true,
  destructiveTooltip = 'Contains destructive operations',
  children,
}: OpSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const allSelected = count > 0 && selectedCount === count;
  const someSelected = selectedCount > 0 && selectedCount < count;

  const handleHeaderClick = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleCheckboxClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      // Stop the click from also toggling the collapse.
      e.stopPropagation();
    },
    [],
  );

  return (
    <Box sx={{ mb: 1.5 }}>
      {/* Header row --------------------------------------------------------- */}
      <Box
        onClick={handleHeaderClick}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          userSelect: 'none',
          transition: 'background-color 0.12s',
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        <Checkbox
          size="small"
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleAll}
          onClick={handleCheckboxClick}
          sx={{ p: 0 }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary' }}>
          {icon}
        </Box>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {title}
        </Typography>
        <Chip
          label={count}
          size="small"
          variant="outlined"
          sx={{
            height: 18,
            fontSize: '0.625rem',
            '& .MuiChip-label': { px: 0.75 },
          }}
        />
        {hasDestructive && (
          <Tooltip title={destructiveTooltip}>
            <WarningIcon sx={{ fontSize: 14, color: 'warning.main', ml: 0.25 }} />
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <IconButton
          size="small"
          sx={{
            p: 0.25,
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.18s',
          }}
          onClick={(e) => {
            e.stopPropagation();
            handleHeaderClick();
          }}
        >
          <ExpandMoreIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      {/* Body --------------------------------------------------------------- */}
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ pt: 0.5, pl: 0.25 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}

export default OpSection;
