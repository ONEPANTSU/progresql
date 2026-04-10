/**
 * Barrel entry for the schema-sync engine. Consumers (the React modal, tests,
 * future CLI tooling) should import from here rather than reaching into
 * individual files, so the internal layout can evolve freely.
 */

export * from './types';
export {
  diffSchemas,
  diffTables,
  diffEnums,
  diffViews,
  diffFunctions,
  diffProcedures,
  diffSequences,
  diffTriggers,
  diffDomains,
  tableQualifiedName,
} from './differs';
export {
  assembleFinalSQL,
  generateTableSQL,
  generateCreateTable,
  generateCreateTableFKs,
  generateAlterTable,
  generateDropTable,
  generateRenameTable,
  renderEnumOp,
  renderViewOp,
  renderRoutineOp,
  renderSequenceOp,
  renderTriggerOp,
  renderDomainOp,
  renderChangeOp,
  configureEnumGeneratorContext,
  getDependenciesForEnum,
  type EnumDependency,
} from './generators';
export { quoteIdent, quoteQualifiedName, quoteLiteral, columnTypeSQL } from './util/sql';
export { levenshtein, similarity, normaliseIdent, bestMatches } from './util/similarity';
export {
  planMigration,
  renderPlanSQL,
  registerOpRenderer,
  type MigrationPlan,
  type MigrationPhaseBlock,
  type PlanOptions,
} from './planner';
export {
  resolveOps,
  splitOpIds,
  resolveTableRenames,
  type UserDecisions,
  type RenameMode,
} from './resolveOps';
