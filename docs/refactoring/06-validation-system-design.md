# Validation System Design - LLM Optimization

> **Version:** 1.0  
> **Date:** January 2026  
> **Purpose:** Transform tool descriptions into aggressive LLM guidance with semantic validation

## Overview

This document specifies a **3-tier validation system** designed to force LLMs to use tools effectively by:
1. Providing aggressive, directive descriptions (not passive suggestions)
2. Validating semantic quality (not just structure)
3. Returning rich error messages with examples when LLMs misuse tools

---

## Problem Statement

### Current LLM Failure Patterns

| Tool | Common Failures | Impact |
|------|----------------|--------|
| **deep_research** | Vague questions like "Research React" | Wasted API calls, poor results |
| **search_reddit** | 1-3 queries instead of 10-50 | Missed consensus, incomplete data |
| **scrape_links** | Not using `use_llm=true` | Basic extraction, missed insights |
| **web_search** | Single keyword instead of 3-7 | Narrow perspective, biased results |
| **file_attachments** | Missing descriptions | No context, poor research quality |

### Root Cause

LLMs are **passive** - they follow suggestions but don't optimize unless forced. Current descriptions say "you can do X" instead of "you MUST do X with these specific requirements."

---

## 3-Tier Validation Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Request Parameters                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 1: Structural Validation (Zod)                        │
│  - Type checking (string, number, array, object)            │
│  - Range validation (minItems, maxItems, minLength)         │
│  - Required fields                                           │
└─────────────────────────┬───────────────────────────────────┘
                          │ PASS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 2: Semantic Validation (Custom Validators)            │
│  - Template compliance (required sections present)          │
│  - Keyword density (min 15 keywords for research)           │
│  - Query diversity (Jaccard similarity < 70%)               │
│  - Conditional requirements (files for code questions)      │
└─────────────────────────┬───────────────────────────────────┘
                          │ PASS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 3: Error Templates (Rich Feedback)                    │
│  - Show BAD vs GOOD examples                                │
│  - Provide step-by-step fix instructions                    │
│  - Link to template sections in description                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
                    Handler Execution
```

---

## YAML Schema Extensions

### New Sections

```yaml
- name: deep_research
  description: |
    [Enhanced with aggressive directives]
  
  # NEW: Validation rules for semantic checking
  validation_rules:
    - rule: template_compliance
      field: questions.*.question
      required_sections:
        - "🎯 WHAT I NEED:"
        - "🤔 WHY I'M RESEARCHING THIS:"
        - "📚 WHAT I ALREADY KNOW:"
        - "❓ SPECIFIC QUESTIONS"
      error_code: "TEMPLATE_VIOLATION"
      error_template: |
        ❌ **Question doesn't follow required template**
        
        **Your question:** {value_preview}
        
        **Missing sections:** {missing_sections}
        
        **Required template:**
        ```
        🎯 WHAT I NEED: [Clear goal]
        🤔 WHY I'M RESEARCHING THIS: [Context/decision]
        📚 WHAT I ALREADY KNOW: [Current understanding]
        ❓ SPECIFIC QUESTIONS (2-5):
        - Question 1: [Specific, pointed]
        - Question 2: [Another specific]
        ```
        
        **BAD Example:**
        "Research React hooks"
        
        **GOOD Example:**
        "🎯 WHAT I NEED: Understand when to use useCallback vs useMemo
        🤔 WHY: Optimizing a data-heavy dashboard with 50+ components
        📚 WHAT I KNOW: Both memoize, but unclear when each is appropriate
        ❓ SPECIFIC QUESTIONS:
        - When does useCallback prevent re-renders vs useMemo?
        - Performance benchmarks: useCallback vs useMemo vs neither?
        - Common anti-patterns that negate their benefits?"
    
    - rule: keyword_density
      field: questions.*.question
      min_keywords: 15
      keyword_types: ["technical_terms", "proper_nouns", "version_numbers", "error_codes"]
      error_code: "VAGUE_QUESTION"
      error_template: |
        ❌ **Question too vague - only {keyword_count} keywords found, need 15+**
        
        **Add specific details:**
        - ✅ Version numbers (React 18, Node 20)
        - ✅ Error codes (ECONNREFUSED, 404)
        - ✅ Library names (axios, express, zod)
        - ✅ Method names (useState, useEffect, map)
        - ✅ File paths (/src/components/Auth.tsx)
        
        **BAD:** "How to handle errors in React?"
        **GOOD:** "How to handle ECONNREFUSED errors in React 18 when using axios 1.6 with Express backend - specifically in useEffect cleanup and AbortController patterns?"
    
    - rule: file_attachment_required
      field: questions.*
      when:
        question_contains: ["bug", "error", "crash", "performance", "refactor", "debug", "fix", "issue"]
      min_attachments: 1
      error_code: "MISSING_FILES"
      error_template: |
        ❌ **Code question detected but NO file attachments provided**
        
        **Detected keywords:** {detected_keywords}
        
        **You MUST attach files when asking about:**
        - 🐛 Bugs/errors → Attach the failing code
        - ⚡ Performance → Attach the slow code path
        - ♻️ Refactoring → Attach current implementation
        - 🔍 Code review → Attach code to review
        
        **How to attach:**
        ```json
        {
          "file_attachments": [{
            "path": "/absolute/path/to/file.ts",
            "description": "[1] What this file is → [2] Why relevant → [3] Focus areas → [4] Known issues"
          }]
        }
        ```
  
  # NEW: Perfect examples
  examples:
    perfect:
      description: "Bug investigation with comprehensive context"
      value:
        questions:
          - question: |
              🎯 WHAT I NEED: Fix race condition in order processing causing duplicate charges
              
              🤔 WHY I'M RESEARCHING THIS: Production issue affecting 5% of transactions, costing $2K/day in refunds
              
              📚 WHAT I ALREADY KNOW: 
              - Race occurs when two requests hit processOrder() simultaneously
              - Using PostgreSQL with READ COMMITTED isolation
              - No row-level locking currently implemented
              
              🔧 HOW I'LL USE THIS: Implement proper locking strategy in order-processor.ts
              
              ❓ SPECIFIC QUESTIONS (5):
              1. PostgreSQL row-level locking: FOR UPDATE vs FOR UPDATE SKIP LOCKED for order processing?
              2. Should we use SELECT FOR UPDATE or optimistic locking with version columns?
              3. How to handle lock timeouts gracefully without failing the entire transaction?
              4. Best practices for testing race conditions in integration tests?
              5. Performance impact: row locks vs optimistic locking at 1000 orders/min scale?
              
              🌐 PRIORITY SOURCES: PostgreSQL official docs, high-traffic e-commerce case studies
              ⚡ PRIORITY INFO: Focus on production-ready patterns, not academic solutions
            
            file_attachments:
              - path: "/Users/dev/ecommerce/src/services/order-processor.ts"
                start_line: 45
                end_line: 120
                description: |
                  [1] Main order processing service handling payment + inventory
                  [2] Race condition occurs in processOrder() when simultaneous requests hit
                  [3] Focus on lines 67-89 where we call decrementStock() and chargePayment() sequentially
                  [4] Suspect the gap between inventory check and payment allows race
                  [5] Related: /src/repositories/inventory-repo.ts (decrementStock method)
    
    anti_patterns:
      - bad: "Research PostgreSQL locking"
        why_bad: "Too vague, no context, no WHY, no specific sub-questions, no files"
        fix: "Use full template with context, 5 specific questions, attach relevant code files"
      
      - bad: "How to fix my bug?"
        why_bad: "No description of bug, no error messages, no code attached"
        fix: "Describe bug symptoms, attach error logs, attach failing code, ask specific questions"
```

---

## Validator Types

### 1. Template Compliance Validator

**Purpose:** Ensure questions follow structured template

**Implementation:**
```typescript
interface TemplateComplianceRule {
  rule: 'template_compliance';
  field: string;
  required_sections: string[];
  error_code: string;
  error_template: string;
}

function validateTemplateCompliance(
  value: string,
  rule: TemplateComplianceRule
): ValidationResult {
  const missing = rule.required_sections.filter(
    section => !value.includes(section)
  );
  
  if (missing.length > 0) {
    return {
      valid: false,
      error_code: rule.error_code,
      error_message: rule.error_template
        .replace('{missing_sections}', missing.join(', '))
        .replace('{value_preview}', value.substring(0, 100) + '...')
    };
  }
  
  return { valid: true };
}
```

### 2. Keyword Density Validator

**Purpose:** Ensure questions are specific, not vague

**Implementation:**
```typescript
interface KeywordDensityRule {
  rule: 'keyword_density';
  field: string;
  min_keywords: number;
  keyword_types: string[];
  error_code: string;
  error_template: string;
}

function extractKeywords(text: string): string[] {
  // Extract technical terms, proper nouns, version numbers, error codes
  const patterns = {
    version: /\b\d+\.\d+(\.\d+)?\b/g,
    error_code: /\b[A-Z_]{3,}\b/g,
    camelCase: /\b[a-z]+[A-Z][a-zA-Z]+\b/g,
    properNoun: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g,
  };
  
  const keywords = new Set<string>();
  for (const [type, pattern] of Object.entries(patterns)) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => keywords.add(m));
  }
  
  return Array.from(keywords);
}

function validateKeywordDensity(
  value: string,
  rule: KeywordDensityRule
): ValidationResult {
  const keywords = extractKeywords(value);
  
  if (keywords.length < rule.min_keywords) {
    return {
      valid: false,
      error_code: rule.error_code,
      error_message: rule.error_template
        .replace('{keyword_count}', keywords.length.toString())
        .replace('{min_keywords}', rule.min_keywords.toString()),
      found_keywords: keywords,
      suggestion: `Add ${rule.min_keywords - keywords.length} more specific terms`
    };
  }
  
  return { valid: true };
}
```

### 3. Query Diversity Validator

**Purpose:** Ensure search queries cover different angles

**Implementation:**
```typescript
interface DiversityRule {
  rule: 'query_diversity';
  field: string;
  max_similarity: number; // 0.7 = 70% overlap threshold
  error_code: string;
  error_template: string;
}

function calculateJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  
  return intersection.size / union.size;
}

function validateQueryDiversity(
  queries: string[],
  rule: DiversityRule
): ValidationResult {
  const similarities: number[] = [];
  
  for (let i = 0; i < queries.length; i++) {
    for (let j = i + 1; j < queries.length; j++) {
      similarities.push(calculateJaccardSimilarity(queries[i], queries[j]));
    }
  }
  
  const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  
  if (avgSimilarity > rule.max_similarity) {
    return {
      valid: false,
      error_code: rule.error_code,
      error_message: rule.error_template
        .replace('{similarity}', (avgSimilarity * 100).toFixed(0) + '%'),
      suggestion: 'Use different angles: direct, comparison, subreddit-specific, year-specific, problem-focused'
    };
  }
  
  return { valid: true };
}
```

### 4. Conditional Validator

**Purpose:** Require file attachments when question contains code-related keywords

**Implementation:**
```typescript
interface ConditionalRule {
  rule: 'file_attachment_required';
  field: string;
  when: {
    question_contains: string[];
  };
  min_attachments: number;
  error_code: string;
  error_template: string;
}

function validateConditional(
  value: any,
  rule: ConditionalRule
): ValidationResult {
  const question = value.question || '';
  const detectedKeywords = rule.when.question_contains.filter(
    kw => question.toLowerCase().includes(kw.toLowerCase())
  );
  
  if (detectedKeywords.length > 0) {
    const attachments = value.file_attachments || [];
    if (attachments.length < rule.min_attachments) {
      return {
        valid: false,
        error_code: rule.error_code,
        error_message: rule.error_template
          .replace('{detected_keywords}', detectedKeywords.join(', ')),
        detected_keywords: detectedKeywords
      };
    }
  }
  
  return { valid: true };
}
```

---

## Integration Flow

### Registry Execution with Validation

```typescript
// src/tools/registry.ts

export async function executeTool(
  name: string,
  args: unknown,
  capabilities: Capabilities
): Promise<CallToolResult> {
  const tool = toolRegistry[name];
  if (!tool) {
    throw new McpError(McpErrorCode.MethodNotFound, `Method not found: ${name}`);
  }

  // Step 1: Check capability
  if (tool.capability && !capabilities[tool.capability]) {
    return {
      content: [{ type: 'text', text: getMissingEnvMessage(tool.capability) }],
      isError: true,
    };
  }

  // Step 2: Run semantic validators (NEW)
  const validationRules = getValidationRules(name);
  if (validationRules && validationRules.length > 0) {
    const validationResult = await runSemanticValidators(args, validationRules);
    if (!validationResult.valid) {
      return formatValidationError(validationResult);
    }
  }

  // Step 3: Validate params with Zod
  let validatedParams: unknown;
  try {
    validatedParams = tool.schema.parse(args);
  } catch (error) {
    // ... existing Zod error handling
  }

  // Step 4-5: Execute handler and transform response
  // ... existing code
}
```

---

## 55 Enhancement Points Summary

| Tool | Enhancements | Key Focus |
|------|--------------|-----------|
| **deep_research** | 13 points | Template compliance, keyword density, file attachments |
| **search_reddit** | 14 points | Query diversity, minimum count, category coverage |
| **scrape_links** | 12 points | use_llm enforcement, extraction prompt quality |
| **web_search** | 6 points | Keyword count, operator usage |
| **file_attachments** | 10 points | Description quality, numbered sections, line ranges |

---

## Next Steps

1. Implement validator infrastructure (Phase 3)
2. Enhance tools.yaml with validation rules (Phase 2)
3. Integrate into loader and registry (Phases 4-5)
4. Test with intentionally bad inputs (Phase 7)
5. Document for v3.5.0 release (Phase 8)
