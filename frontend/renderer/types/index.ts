export interface DatabaseConnection {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  connectionName: string;
}

export interface DatabaseConnectionWithId extends DatabaseConnection {
  id: string;
  isActive: boolean;
  lastConnected?: string;
}

export interface AvailableDatabase {
  name: string;
  owner?: string;
  encoding?: string;
  size?: string;
}

export interface DatabaseServer extends DatabaseConnectionWithId {
  databases: DatabaseInfo[];
  availableDatabases?: AvailableDatabase[];
  activeDatabase?: string;
}

export interface DatabaseInfo {
  name: string;
  size?: string;
  encoding?: string;
  collation?: string;
  owner?: string;
  tables: Table[];
  views: View[];
  functions: Function[];
  procedures: Procedure[];
  triggers: Trigger[];
  indexes: Index[];
  constraints: Constraint[];
  sequences: Sequence[];
  schemas: Schema[];
  extensions: Extension[];
  languages: Language[];
  types: CustomType[];
  operators: Operator[];
  operatorClasses: OperatorClass[];
  operatorFamilies: OperatorFamily[];
  conversions: Conversion[];
  casts: Cast[];
  foreignDataWrappers: ForeignDataWrapper[];
  foreignServers: ForeignServer[];
  userMappings: UserMapping[];
  policies: Policy[];
  rules: Rule[];
  publications: Publication[];
  subscriptions: Subscription[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: Field[];
  message: string;
  timestamp: string;
}

export interface Field {
  name: string;
  dataType: number;
  dataTypeName: string;
}

export interface DatabaseStructureResponse {
  success: boolean;
  message?: string;
  database_name?: string;
  databases?: DatabaseInfo[];
}

/** @deprecated Use DatabaseStructureResponse instead */
export type DatabaseStructure = DatabaseStructureResponse;


export interface Table {
  table_name: string;
  table_type: string;
  table_schema: string;
  table_catalog: string;
  row_count?: number;
  size?: string;
  description?: string;
  columns?: Column[];
  indexes?: Index[];
  constraints?: Constraint[];
  triggers?: Trigger[];
}

export interface View {
  view_name: string;
  view_definition: string;
  view_schema: string;
  view_catalog: string;
  is_updatable: boolean;
  is_insertable_into: boolean;
  is_trigger_insertable_into: boolean;
}

export interface Column {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
  character_maximum_length?: number;
  numeric_precision?: number;
  numeric_scale?: number;
  datetime_precision?: number;
  udt_name: string;
  is_identity: boolean;
  identity_generation?: string;
  comment?: string;
}

export interface Index {
  index_name: string;
  table_name: string;
  index_type: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: string[];
  index_definition: string;
  tablespace?: string;
  fill_factor?: number;
  is_clustered: boolean;
}

export interface Constraint {
  constraint_name: string;
  table_name: string;
  constraint_type: string;
  column_name: string;
  referenced_table?: string;
  referenced_column?: string;
  check_condition?: string;
  deferrable: boolean;
  initially_deferred: boolean;
  on_delete?: string;
  on_update?: string;
}

export interface Trigger {
  trigger_name: string;
  table_name: string;
  event_manipulation: string;
  event_object_schema: string;
  event_object_table: string;
  action_statement: string;
  action_timing: string;
  action_orientation: string;
  action_condition?: string;
  action_reference_old_table?: string;
  action_reference_new_table?: string;
}

export interface Function {
  routine_name: string;
  routine_type: string;
  data_type: string;
  routine_schema: string;
  routine_catalog: string;
  parameter_name?: string;
  parameter_mode?: string;
  parameter_default?: string;
  parameter_ordinal_position?: number;
  is_deterministic: boolean;
  sql_data_access: string;
  is_null_call: boolean;
  security_type: string;
  routine_definition: string;
  external_language?: string;
}

export interface Procedure {
  procedure_name: string;
  procedure_schema: string;
  procedure_catalog: string;
  parameter_name?: string;
  parameter_mode?: string;
  parameter_default?: string;
  parameter_ordinal_position?: number;
  is_deterministic: boolean;
  sql_data_access: string;
  is_null_call: boolean;
  security_type: string;
  procedure_definition: string;
  external_language?: string;
}

export interface Sequence {
  sequence_name: string;
  sequence_schema: string;
  sequence_catalog: string;
  data_type: string;
  start_value: number;
  minimum_value: number;
  maximum_value: number;
  increment: number;
  cycle_option: boolean;
  cache_size: number;
  last_value?: number;
}

export interface Schema {
  schema_name: string;
  schema_owner: string;
  default_character_set_catalog?: string;
  default_character_set_schema?: string;
  default_character_set_name?: string;
  default_collation_catalog?: string;
  default_collation_schema?: string;
  default_collation_name?: string;
  description?: string;
}

export interface Extension {
  name: string;
  version: string;
  schema: string;
  description?: string;
}

export interface Language {
  name: string;
  owner: string;
  is_trusted: boolean;
  handler_function: string;
  validator_function?: string;
}

export interface CustomType {
  name: string;
  schema: string;
  owner: string;
  type_category: string;
  is_preferred: boolean;
  is_instantiable: boolean;
  base_type?: string;
  element_type?: string;
  enum_values?: string[];
}

export interface Operator {
  name: string;
  schema: string;
  owner: string;
  left_type: string;
  right_type: string;
  result_type: string;
  commutator?: string;
  negator?: string;
  is_hashable: boolean;
  is_merge_joinable: boolean;
}

export interface OperatorClass {
  name: string;
  schema: string;
  owner: string;
  access_method: string;
  data_type: string;
  is_default: boolean;
}

export interface OperatorFamily {
  name: string;
  schema: string;
  owner: string;
  access_method: string;
}

export interface Conversion {
  name: string;
  schema: string;
  owner: string;
  source_encoding: string;
  dest_encoding: string;
  is_default: boolean;
  is_functional: boolean;
}

export interface Cast {
  source_type: string;
  target_type: string;
  cast_function?: string;
  cast_method: string;
  is_implicit: boolean;
  is_assignment: boolean;
}

export interface ForeignDataWrapper {
  name: string;
  owner: string;
  handler?: string;
  validator?: string;
  options?: Record<string, string>;
}

export interface ForeignServer {
  name: string;
  owner: string;
  foreign_data_wrapper: string;
  type?: string;
  version?: string;
  options?: Record<string, string>;
}

export interface UserMapping {
  server_name: string;
  user_name: string;
  options?: Record<string, string>;
}

export interface Policy {
  name: string;
  table_name: string;
  schema_name: string;
  roles: string[];
  command: string;
  qual?: string;
  with_check?: string;
}

export interface Rule {
  name: string;
  table_name: string;
  schema_name: string;
  definition: string;
  is_instead: boolean;
}

export interface Publication {
  name: string;
  owner: string;
  all_tables: boolean;
  all_schemas: boolean;
  tables: string[];
  schemas: string[];
}

export interface Subscription {
  name: string;
  owner: string;
  enabled: boolean;
  publication_name: string;
  connection_string: string;
  slot_name?: string;
}

// Auth types
export type SubscriptionWarning = 'expiring_soon' | 'expired' | null;

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  plan?: 'free' | 'trial' | 'pro' | 'pro_plus' | 'team';
  planExpiresAt?: string;
  trialEndsAt?: string;
  subscriptionWarning?: SubscriptionWarning;
  marketingConsent?: boolean;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isEmailVerified: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (name: string, email: string, password: string, marketingConsent?: boolean) => Promise<void>;
  logout: () => void;
  sendVerificationCode: () => Promise<string>;
  verifyCode: (code: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

// SQL Tab types
export interface SQLTab {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  createdAt: string;
}

// Chat types
export interface Chat {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
  hasSentFirstMessage: boolean;
  connectionId?: string;
  database?: string;
}

export interface MessageVisualization {
  chart_type: 'bar' | 'line' | 'pie' | 'area' | 'metric' | 'table';
  title: string;
  data: Record<string, unknown>[];
  x_label?: string;
  y_label?: string;
  sql?: string;
}

export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
  isStreaming?: boolean;
  visualization?: MessageVisualization;
  modelUsed?: string;
  modelTier?: 'budget' | 'premium';
  costRUB?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// WebSocket message types
export interface WebSocketMessage {
  type: string;
  payload: unknown;
  chatId?: string;
  timestamp?: string;
}

export interface DatabaseSchemaMessage {
  dbms: string;
  schemas: string[];
  entities: {
    tables: string[];
    views: string[];
    sequences: string[];
    functions: string[];
  };
}

export interface ChatMessagePayload {
  chatId: string;
  message: string;
  schema?: DatabaseSchemaMessage;
}

// Quota & Balance types
export interface QuotaInfo {
  plan: string;
  budget_tokens_limit: number;
  premium_tokens_limit: number;
  period_type: 'daily' | 'monthly';
  autocomplete_enabled: boolean;
  balance_markup_pct: number;
  balance_enabled: boolean;
  max_requests_per_min: number;
  max_tokens_per_request: number;
}

export interface UsageInfo {
  budget_tokens_used: number;
  budget_tokens_limit: number;
  premium_tokens_used: number;
  premium_tokens_limit: number;
  period_start: string;
  period_end: string;
  period_type: 'daily' | 'monthly';
  balance: number;
  balance_enabled: boolean;
  plan: string;
}

export interface BalanceInfo {
  balance: number;
  currency: string;
}

export interface BalanceTransaction {
  id: string;
  amount: number;
  balance_after: number;
  tx_type: 'top_up' | 'model_charge' | 'over_quota_charge' | 'refund';
  model_id: string;
  tokens_input: number;
  tokens_output: number;
  description: string;
  created_at: string;
}

export interface PlanPrice {
  plan: string;
  price: number;
  original_price: number;
  currency: string;
  period: string;
}

export interface PricesResponse {
  plans: PlanPrice[];
  min_balance_topup: number;
  max_balance_topup: number;
}

// Usage history types
export interface UsageRecord {
  id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  action: string;
  created_at: string;
}

export interface UsageStats {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  avg_tokens_per_request: number;
  avg_cost_per_request_usd: number;
}

export interface UsageHistoryResponse {
  records: UsageRecord[];
  stats: UsageStats;
  total: number;
  limit: number;
  offset: number;
}

export interface ModelPricing {
  id: string;
  name: string;
  tier: string;
  input_price_per_m: number;
  output_price_per_m: number;
}

export interface ModelPricingResponse {
  models: ModelPricing[];
  usd_to_rub: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: 'budget' | 'premium';
  input_price_per_m: number;
  output_price_per_m: number;
  is_default: boolean;
}
