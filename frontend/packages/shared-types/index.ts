/**
 * Shared types for MCP tool calling protocol
 * Used for communication between backend LLM and desktop executor
 */

export interface ToolRequest {
  requestId: string;
  toolName: string;
  arguments: Record<string, any>;
  meta?: {
    userId?: string;
    chatId?: string;
    traceId?: string;
    timestamp?: string;
  };
}

export interface ToolResult {
  requestId: string;
  ok: boolean;
  result?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    executionTime?: number;
    timestamp?: string;
  };
}

/**
 * MCP Protocol types
 */
export interface McpMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: McpError;
}

export interface McpError {
  code: number;
  message: string;
  data?: any;
}

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities?: {
    tools?: {};
    prompts?: {};
  };
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: {};
    prompts?: {};
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, any>;
}

export interface McpToolCallResult {
  content: Array<{
    type: string;
    text?: string;
    data?: any;
  }>;
  isError?: boolean;
}
