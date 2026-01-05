/**
 * TypeScript interfaces for YAML tool configuration
 * Matches structure defined in yaml/tools.yaml
 */

import type { Capabilities } from './index.js';

/**
 * Validation rules for parameters
 */
export interface YamlValidation {
  // String validations
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'uri' | 'email' | 'uuid';

  // Number validations
  min?: number;
  max?: number;
  int?: boolean;
  positive?: boolean;
  negative?: boolean;

  // Array validations
  minItems?: number;
  maxItems?: number;
  nonempty?: boolean;
}

/**
 * Parameter definition in YAML
 */
export interface YamlParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  description?: string;
  validation?: YamlValidation;

  // For array type
  items?: YamlParameter;

  // For object type
  properties?: Record<string, YamlParameter>;
}

/**
 * Tool definition in YAML
 */
export interface YamlToolConfig {
  name: string;
  category?: string;
  capability?: keyof Capabilities;
  description: string;

  // For tools with simple inline parameters
  parameters?: Record<string, YamlParameter>;

  // For tools using existing Zod schemas
  useZodSchema?: boolean;
  zodSchemaRef?: string;

  // Description overrides for existing Zod schemas
  schemaDescriptions?: Record<string, string>;

  // Configurable limits and settings
  limits?: Record<string, string | number | boolean>;
}

/**
 * Root YAML configuration structure
 */
export interface YamlConfig {
  version: string;
  metadata: {
    name: string;
    description: string;
  };
  tools: YamlToolConfig[];
}

/**
 * MCP Tool definition (matches SDK)
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Loaded tool with additional metadata
 */
export interface LoadedTool extends McpTool {
  category?: string;
  capability?: keyof Capabilities;
  useZodSchema?: boolean;
  zodSchemaRef?: string;
}
