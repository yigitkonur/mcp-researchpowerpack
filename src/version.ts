/**
 * Version Module - Single Source of Truth
 * 
 * This module reads the version from package.json at runtime.
 * All version references in the codebase should import from here.
 * 
 * Usage:
 *   import { VERSION, PACKAGE_NAME } from './version.js';
 * 
 * The version is automatically synced with package.json - no manual updates needed.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Create a require function for ESM to import JSON
const require = createRequire(import.meta.url);

// Get the directory of this file to find package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load package.json - works from both src/ and dist/
let packageJson: { version: string; name: string; description: string };

try {
  // Try loading from project root (when running from dist/)
  packageJson = require(join(__dirname, '..', 'package.json'));
} catch {
  try {
    // Try loading from two levels up (when running from src/)
    packageJson = require(join(__dirname, '..', '..', 'package.json'));
  } catch {
    // Fallback if package.json can't be found (should never happen)
    console.error('[Version] Warning: Could not load package.json, using fallback version');
    packageJson = {
      version: '0.0.0-unknown',
      name: 'research-powerpack-mcp',
      description: 'Research Powerpack MCP Server',
    };
  }
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
 * Example: "research-powerpack-mcp/3.2.0"
 */
export const USER_AGENT_VERSION: string = `${PACKAGE_NAME}/${VERSION}`;

// VERSION_INFO removed - unused, individual exports sufficient
