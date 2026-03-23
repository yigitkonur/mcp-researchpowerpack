/**
 * Version Module - Single Source of Truth
 * 
 * This module reads package metadata from package.json at runtime and keeps a
 * fallback copy for environments where package.json cannot be resolved.
 * 
 * Usage:
 *   import { VERSION, PACKAGE_NAME } from './version.js';
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Defaults used if package.json cannot be loaded at runtime.
const DEFAULT_PACKAGE_INFO = {
  version: '3.9.5',
  name: 'mcp-researchpowerpack-http',
  description: 'Research Powerpack MCP Server',
} as const;

let packageJson: { version: string; name: string; description: string } = { ...DEFAULT_PACKAGE_INFO };

try {
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
    const _require = createRequire(import.meta.url);
    const _dirname = dirname(fileURLToPath(import.meta.url));
    try {
      packageJson = _require(join(_dirname, '..', 'package.json'));
    } catch {
      packageJson = _require(join(_dirname, '..', '..', 'package.json'));
    }
  }
} catch {
  // Keep hardcoded defaults when package.json is unavailable
}

/**
 * Package version from package.json
 * This is the single source of truth for versioning
 */
export const VERSION: string = packageJson.version;

/**
 * Package name from package.json
 */
export const PACKAGE_NAME: string = packageJson.name;

/**
 * Package description from package.json
 */
export const PACKAGE_DESCRIPTION: string = packageJson.description;

/**
 * Formatted version string for user agents and logging
 * Example: "mcp-researchpowerpack-http/3.2.0"
 */
export const USER_AGENT_VERSION: string = `${PACKAGE_NAME}/${VERSION}`;

// VERSION_INFO removed - unused, individual exports sufficient
