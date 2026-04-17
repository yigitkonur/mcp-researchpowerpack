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
  source_priority: ['vendor_docs', 'github_code', 'release_notes'],
  sources_to_deprioritize: ['reddit', 'blogs'],
  fire_reddit_branch: false,
  fire_reddit_reason: 'Spec question — docs are authoritative.',
  freshness_window: 'months',
  concept_groups: [
    {
      facet: 'Official spec',
      queries: [
        'site:docs.ghostty.org toggle_tab_overview',
        'ghostty keybinding reference macos',
      ],
    },
    {
      facet: 'Platform compat',
      queries: [
        'ghostty macos vs linux features',
        'ghostty gtk-only actions',
      ],
    },
  ],
  anticipated_gaps: ['Explicit macOS confirmation', 'Changelog entry date'],
  first_scrape_targets: ['docs.ghostty.org', 'github.com/ghostty-org/ghostty'],
  success_criteria: ['Confirmed macOS support or refutation', 'Source cited'],
});

test('parseResearchBrief accepts a valid JSON brief', () => {
  const brief = parseResearchBrief(validBriefJson);
  assert.notEqual(brief, null);
  assert.equal(brief!.goal_class, 'spec');
  assert.equal(brief!.fire_reddit_branch, false);
  assert.equal(brief!.concept_groups.length, 2);
  assert.equal(brief!.concept_groups[0]!.facet, 'Official spec');
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

test('parseResearchBrief rejects missing concept_groups', () => {
  const bad = JSON.parse(validBriefJson);
  delete bad.concept_groups;
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects empty concept_groups', () => {
  const bad = JSON.parse(validBriefJson);
  bad.concept_groups = [];
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects concept groups with empty queries[]', () => {
  const bad = JSON.parse(validBriefJson);
  bad.concept_groups[0].queries = [];
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects concept groups with blank facet', () => {
  const bad = JSON.parse(validBriefJson);
  bad.concept_groups[0].facet = '   ';
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects invalid freshness_window', () => {
  const bad = JSON.parse(validBriefJson);
  bad.freshness_window = 'centuries';
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('parseResearchBrief rejects non-boolean fire_reddit_branch', () => {
  const bad = JSON.parse(validBriefJson);
  bad.fire_reddit_branch = 'yes';
  assert.equal(parseResearchBrief(JSON.stringify(bad)), null);
});

test('renderResearchBrief emits expected section headings and content', () => {
  const brief = parseResearchBrief(validBriefJson) as ResearchBrief;
  const md = renderResearchBrief(brief);

  assert.match(md, /## Your research brief \(goal-tailored\)/);
  assert.match(md, /\*\*Goal class\*\*: `spec`/);
  assert.match(md, /\*\*Freshness target\*\*: `months`/);
  assert.match(md, /\*\*Reddit branch\*\*: skip/);
  assert.match(md, /### Pass 1 concept groups/);
  assert.match(md, /#### Official spec/);
  assert.match(md, /#### Platform compat/);
  assert.match(md, /site:docs.ghostty.org toggle_tab_overview/);
  assert.match(md, /### Anticipated gaps/);
  assert.match(md, /### First-pass scrape targets/);
  assert.match(md, /### Success criteria/);
});

test('renderResearchBrief marks Reddit fire=true correctly', () => {
  const brief = parseResearchBrief(validBriefJson) as ResearchBrief;
  const fireBrief: ResearchBrief = { ...brief, fire_reddit_branch: true, fire_reddit_reason: 'migration story' };
  const md = renderResearchBrief(fireBrief);
  assert.match(md, /\*\*Reddit branch\*\*: \*\*fire\*\* — migration story/);
});
