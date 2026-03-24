/**
 * File attachment service for reading and formatting file contents
 */

import { access, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { pMap } from '../utils/concurrency.js';


/** Default concurrency for parallel file reads */
const FILE_READ_CONCURRENCY = 5 as const;

interface FileAttachment {
  readonly path: string;
  readonly start_line?: number | undefined;
  readonly end_line?: number | undefined;
  readonly description?: string | undefined;
}

interface FormattedFileResult {
  readonly success: boolean;
  readonly path: string;
  readonly content: string;
  readonly error?: string | undefined;
}

export class FileAttachmentService {
  /**
   * Format multiple file attachments into a markdown section
   */
  async formatAttachments(attachments: FileAttachment[]): Promise<string> {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const results = await pMap(attachments, (attachment) => this.formatSingleFile(attachment), FILE_READ_CONCURRENCY);

    // Build the attachments section
    const parts: string[] = ['\n\n---\n\n# 📎 ATTACHED FILES\n\n'];
    parts.push(`*${results.length} file${results.length > 1 ? 's' : ''} attached for context*\n\n`);
    for (const result of results) {
      parts.push(result.content);
      parts.push('\n\n');
    }
    return parts.join('');
  }

  /**
   * Format a single file attachment
   */
  private async formatSingleFile(attachment: FileAttachment): Promise<FormattedFileResult> {
    const { path, start_line, end_line, description } = attachment;

    // Check if file exists
    try {
      await access(path);
    } catch {
      return {
        success: false,
        path,
        content: `## ❌ ${path}\n\n**FILE NOT FOUND**\n${description ? `\n*Description:* ${description}\n` : ''}`,
        error: 'File not found',
      };
    }

    try {
      // Read file content
      const content = await readFile(path, 'utf-8');
      const lines = content.split('\n');
      const language = this.detectLanguage(path);

      // Validate line ranges
      const validatedRange = this.validateLineRange(start_line, end_line, lines.length);
      if (!validatedRange.valid) {
        return {
          success: false,
          path,
          content: `## ⚠️ ${path}\n\n**INVALID LINE RANGE**: ${validatedRange.error}\n${description ? `\n*Description:* ${description}\n` : ''}`,
          error: validatedRange.error,
        };
      }

      // Extract relevant lines
      const startIdx = validatedRange.start - 1;
      const endIdx = validatedRange.end - 1;
      const selectedLines = lines.slice(startIdx, endIdx + 1);

      // Build formatted output
      let formatted = `## 📄 ${path}\n\n`;

      // Add metadata
      const isPartial = start_line !== undefined || end_line !== undefined;
      formatted += `**Language:** ${language} | `;
      formatted += `**Lines:** ${isPartial ? `${validatedRange.start}-${validatedRange.end}` : lines.length} | `;
      formatted += `**Size:** ${(content.length / 1024).toFixed(2)} KB\n`;

      if (description) {
        formatted += `\n*${description}*\n`;
      }

      formatted += '\n';

      // Add file content with line numbers
      formatted += this.formatCodeBlock(selectedLines, language, startIdx);

      return {
        success: true,
        path,
        content: formatted,
      };
    } catch {
      return {
        success: false,
        path,
        content: `## ❌ ${path}\n\n**ERROR READING FILE**: Unable to read the specified file. Please verify the file path exists and is accessible.\n${description ? `\n*Description:* ${description}\n` : ''}`,
        error: 'Unable to read the specified file',
      };
    }
  }

  /**
   * Format code block with line numbers
   */
  private formatCodeBlock(lines: string[], language: string, startIdx: number): string {
    const parts: string[] = [`\`\`\`${language.toLowerCase()}\n`];

    for (let idx = 0; idx < lines.length; idx++) {
      const lineNumber = startIdx + idx + 1;
      parts.push(`${lineNumber.toString().padStart(4, ' ')}: ${lines[idx]}\n`);
    }

    parts.push('```');
    return parts.join('');
  }

  /**
   * Validate line range and return corrected values
   */
  private validateLineRange(
    start_line: number | undefined,
    end_line: number | undefined,
    totalLines: number
  ): { valid: boolean; start: number; end: number; error?: string } {
    // No range specified - return full file
    if (start_line === undefined && end_line === undefined) {
      return { valid: true, start: 1, end: totalLines };
    }

    // Only start_line specified
    if (start_line !== undefined && end_line === undefined) {
      if (start_line < 1 || start_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `start_line ${start_line} out of range (1-${totalLines})`,
        };
      }
      return { valid: true, start: start_line, end: totalLines };
    }

    // Only end_line specified
    if (start_line === undefined && end_line !== undefined) {
      if (end_line < 1 || end_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `end_line ${end_line} out of range (1-${totalLines})`,
        };
      }
      return { valid: true, start: 1, end: end_line };
    }

    // Both specified
    if (start_line !== undefined && end_line !== undefined) {
      if (start_line < 1 || start_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `start_line ${start_line} out of range (1-${totalLines})`,
        };
      }
      if (end_line < 1 || end_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `end_line ${end_line} out of range (1-${totalLines})`,
        };
      }
      if (start_line > end_line) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `start_line ${start_line} cannot be greater than end_line ${end_line}`,
        };
      }
      return { valid: true, start: start_line, end: end_line };
    }

    return { valid: true, start: 1, end: totalLines };
  }

  private detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescript',
      '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
      '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
      '.md': 'markdown', '.html': 'html', '.css': 'css', '.sql': 'sql',
      '.sh': 'bash', '.xml': 'xml',
    };
    if (filePath.endsWith('Dockerfile')) return 'dockerfile';
    return map[ext] || 'text';
  }
}
