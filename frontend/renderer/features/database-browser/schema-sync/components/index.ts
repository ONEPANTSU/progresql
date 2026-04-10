/**
 * Barrel for Schema Sync UI primitives. Exports `OpSection` and `OpRow`,
 * the two reusable building blocks that replace the bespoke inline section
 * markup that grew organically across `SchemaSyncModal.tsx`.
 */

export { OpSection, type OpSectionProps } from './OpSection';
export { OpRow, type OpRowProps } from './OpRow';
export {
  RenameResolverButtons,
  type RenameResolverButtonsProps,
} from './RenameResolverButtons';
