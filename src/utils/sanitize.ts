const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const URLS = /https?:\/\/\S+/gi;
const MARKDOWN_LINKS = /\[([^\]]+)\]\([^)]+\)/g;

export function sanitizeSuggestion(input: string): string {
  return input
    .replace(CONTROL_CHARS, ' ')
    .replace(MARKDOWN_LINKS, '$1')
    .replace(URLS, '')
    .replace(/\s+/g, ' ')
    .trim();
}
