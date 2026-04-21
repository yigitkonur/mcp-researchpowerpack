import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseResearchBrief,
  renderResearchBrief,
  type ResearchBrief,
} from '../src/services/llm-processor.js';

const validBriefJson = JSON.stringify({
  goal_class: 'spec',
  goal_class_reason: 'Goal asks about a documented API feature.',
  primary_branch: 'web',
  primary_branch_reason: 'Spec question — vendor docs and release notes are authoritative.',
  freshness_window: 'months',
  first_call_sequence: [
    { tool: 'web-search', reason: 'Cover vendor docs + release notes for the feature' },
    { tool: 'scrape-links', reason: 'Extract verbatim API signatures from HIGHLY_RELEVANT docs URLs' },
  ],
  keyword_seeds: [
    'site:docs.ghostty.org toggle_tab_overview',
    'ghostty keybinding reference macos',
    'ghostty macos vs linux features',
    'ghostty gtk-only actions',
  ],
  iteration_hints: [
    'Watch for "macos only" / "linux only" flags in Follow-up signals',
  ],
  gaps_to_watch: ['Explicit macOS confirmation', 'Changelog entry date'],
  stop_criteria: ['Confirmed macOS support or refutation', 'Source cited verbatim'],
});

test('parseResearchBrief accepts a valid JSON brief', () => {
  const brief = parseResearchBrief(validBriefJson);
  assert.notEqual(brief, null);
  assert.equal(brief!.goal_class, 'spec');
  assert.equal(brief!.primary_branch, 'web');
  assert.equal(brief!.first_call_sequence.length, 2);
  assert.equal(brief!.first_call_sequence[0]!.tool, 'web-search');
  assert.equal(brief!.keyword_seeds.length, 4);
});

test('parseResearchBrief tolerates wrapping code fences', () => {
  const fenced = '```json\n' + validBriefJson + '\n```';
  const brief = parseResearchBrief(fenced);
  assert.notEqual(brief, null);
  assert.equal(brief!.goal_class, 'spec');
});

test('parseResearchBrief rejects invalid JSON', () => {
  assert.equal(parseResearchBrief('not json at all'), null);
  assert.equal(parseResearchBrief(''), null);
});

test('parseResearchBrief rejects unknown goal_class', () => {
  const bad = JSON.parse(validBriefJson);
  bad.goal_class = 'nonsense';
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects unknown primary_branch', () => {
  const bad = JSON.parse(validBriefJson);
  bad.primary_branch = 'hackernews';
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects empty first_call_sequence', () => {
  const bad = JSON.parse(validBriefJson);
  bad.first_call_sequence = [];
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects first_call_sequence step with unknown tool', () => {
  const bad = JSON.parse(validBriefJson);
  bad.first_call_sequence = [{ tool: 'get-reddit-post', reason: 'legacy' }];
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects first_call_sequence step with empty reason', () => {
  const bad = JSON.parse(validBriefJson);
  bad.first_call_sequence = [{ tool: 'web-search', reason: '   ' }];
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects missing keyword_seeds', () => {
  const bad = JSON.parse(validBriefJson);
  delete bad.keyword_seeds;
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects empty keyword_seeds', () => {
  const bad = JSON.parse(validBriefJson);
  bad.keyword_seeds = [];
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects invalid freshness_window', () => {
  const bad = JSON.parse(validBriefJson);
  bad.freshness_window = 'centuries';
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('renderResearchBrief emits expected section headings and content', () => {
  const brief = parseResearchBrief(validBriefJson) as ResearchBrief;
  const md = renderResearchBrief(brief);

  assert.match(md, /## Your research brief \(goal-tailored\)/);
  assert.match(md, /\*\*Goal class\*\*: `spec`/);
  assert.match(md, /\*\*Primary branch\*\*: `web`/);
  assert.match(md, /\*\*Freshness\*\*: `months`/);
  assert.match(md, /### First-call sequence/);
  assert.match(md, /1\. `web-search`/);
  assert.match(md, /2\. `scrape-links`/);
  assert.match(md, /### Keyword seeds \(4\)/);
  assert.match(md, /site:docs.ghostty.org toggle_tab_overview/);
  assert.match(md, /### Iteration hints/);
  assert.match(md, /### Gaps to watch/);
  assert.match(md, /### Stop criteria/);
});

test('renderResearchBrief handles primary_branch=reddit', () => {
  const brief = parseResearchBrief(validBriefJson) as ResearchBrief;
  const redditBrief: ResearchBrief = {
    ...brief,
    primary_branch: 'reddit',
    primary_branch_reason: 'migration story — practitioners are authoritative',
  };
  const md = renderResearchBrief(redditBrief);
  assert.match(md, /\*\*Primary branch\*\*: `reddit` — migration story/);
});

test('renderResearchBrief handles primary_branch=both', () => {
  const brief = parseResearchBrief(validBriefJson) as ResearchBrief;
  const bothBrief: ResearchBrief = {
    ...brief,
    primary_branch: 'both',
    primary_branch_reason: 'launch needs official spec + practitioner reception',
  };
  const md = renderResearchBrief(bothBrief);
  assert.match(md, /\*\*Primary branch\*\*: `both`/);
});
