# LLM Optimization Summary - Quick Reference

> **Purpose:** Transform tools.yaml into aggressive LLM prompt engineering with validation  
> **Impact:** Force LLMs to use tools optimally, not just adequately

---

## The Problem

**LLMs are passive.** They follow suggestions but don't optimize unless forced.

Current descriptions say: *"You can provide multiple queries for better results"*  
Should say: **"PROVIDE 10-50 QUERIES. Minimum 10 required. Each query = different angle."**

---

## The Solution: 3-Tier Validation

```
Tier 1: Structural (Zod)     → Types, ranges, required fields
Tier 2: Semantic (Custom)    → Template compliance, keyword density, diversity
Tier 3: Error Templates      → BAD vs GOOD examples, fix instructions
```

---

## 55 Enhancement Points by Tool

### deep_research (13 points)
1. ✅ Template compliance validator (7 required sections)
2. ✅ Keyword density validator (min 15 technical terms)
3. ✅ File attachment conditional (MUST attach for bug/error/performance)
4. ✅ Anti-patterns section (show bad examples)
5. ✅ Perfect example (full template filled)
6. ✅ Aggressive description ("NEVER ask vague questions")
7. ✅ Question length validator (min 200 chars)
8. ✅ Detect template sections via regex
9. ✅ Count specific keywords (version, error, bug, etc.)
10. ✅ Validate file attachments for code keywords
11. ✅ Check using multiple questions (encourage 5-10)
12. ✅ Rich error: "Question too vague" → show example
13. ✅ Rich error: "Missing files" → explain when mandatory

### search_reddit (14 points)
14. ✅ Query count validator (warn <10, error <3)
15. ✅ Query diversity validator (Jaccard similarity <70%)
16. ✅ Subreddit targeting check (r/...)
17. ✅ Year-specific query check (2024, 2025)
18. ✅ Comparison keyword check (vs, versus, compared to)
19. ✅ Problem keyword check (issue, bug, crash, slow)
20. ✅ Add "MINIMUM 10 queries" in bold
21. ✅ Add 10-category query formula
22. ✅ Show BAD vs GOOD examples
23. ✅ Stress: "Each query = different angle. Overlap = wasted slot"
24. ✅ Query crafting template with fill-in-the-blanks
25. ✅ Error: "Only X queries" → show 10-category template
26. ✅ Error: "Queries too similar" → show diversity examples
27. ✅ Error: "No subreddit targeting" → explain r/subreddit syntax

### scrape_links (12 points)
28. ✅ Change to "ALWAYS use use_llm=true"
29. ✅ what_to_extract template with OR statements
30. ✅ Extraction prompt formula: "Extract [topic1] | [topic2] | [topic3]..."
31. ✅ BAD vs GOOD extraction examples
32. ✅ Stress: "More keywords = better extraction. Use 10+ targets"
33. ✅ use_llm validator (warn if false)
34. ✅ what_to_extract length validator (min 50 chars)
35. ✅ Extraction target count via pipe | delimiter (min 3)
36. ✅ Check for focus keywords (with focus on, emphasizing)
37. ✅ Error: "use_llm not enabled" → explain benefits
38. ✅ Error: "Extraction too vague" → show template
39. ✅ Error: "Not enough targets" → explain parallel extraction

### web_search (6 points)
40. ✅ Add "MINIMUM 3 keywords, RECOMMENDED 5-7" in caps
41. ✅ Search operator examples in every category
42. ✅ Formula: [base term] + [operator variation]
43. ✅ BAD vs GOOD examples
44. ✅ Keyword count validator (error if <3)
45. ✅ Operator detection (site:, -, ", filetype:) - warn if none

### file_attachments (10 points)
46. ✅ Make description MANDATORY in validation
47. ✅ 5-section description template
48. ✅ BAD vs GOOD description examples
49. ✅ Validate description has numbered sections [1], [2], [3]
50. ✅ Description length validator (min 100 chars)
51. ✅ For files >500 lines, require start_line/end_line
52. ✅ Validate path is absolute (starts with /)
53. ✅ Check for multiple attachments on code questions (min 2)
54. ✅ Error: "Description too brief" → show 5-section template
55. ✅ Error: "Large file without line range" → explain focus benefits

---

## Implementation Phases

### Phase 1: Design ✅ (COMPLETE)
- Created validation architecture doc
- Designed YAML schema extensions
- Documented 55 enhancement points
- Created validator type definitions

### Phase 2: YAML Enhancement (HIGH PRIORITY)
**Files to modify:** `src/config/yaml/tools.yaml`

For each tool, add:
```yaml
validation_rules:
  - rule: template_compliance
    # ... validator config
  - rule: keyword_density
    # ... validator config

examples:
  perfect:
    # ... perfect example
  anti_patterns:
    # ... bad examples with fixes
```

### Phase 3: Validator Infrastructure (HIGH PRIORITY)
**New files:**
- `src/config/validation-rules.ts` - TypeScript interfaces
- `src/config/validators.ts` - Validator functions

**Validators to implement:**
1. `validateTemplateCompliance()` - Check required sections
2. `validateKeywordDensity()` - Count technical terms
3. `validateQueryDiversity()` - Jaccard similarity
4. `validateConditional()` - File attachments when needed

### Phase 4: Integration (HIGH PRIORITY)
**Modified files:**
- `src/config/types.ts` - Add ValidationRule interfaces
- `src/config/loader.ts` - Parse validation_rules from YAML
- `src/tools/registry.ts` - Add validation middleware

**Execution flow:**
```typescript
executeTool() {
  1. Lookup tool
  2. Check capability
  3. RUN SEMANTIC VALIDATORS ← NEW
  4. Validate with Zod
  5. Execute handler
}
```

### Phase 5-8: Testing, Errors, Documentation (MEDIUM PRIORITY)
- Test validators with bad inputs
- Format rich error responses
- Update migration guide
- Release as v3.5.0

---

## Quick Start: Enhance One Tool

To see the impact immediately, enhance `search_reddit` first:

**Before:**
```yaml
description: |
  Search Reddit via Google. Supports 3-50 queries.
```

**After:**
```yaml
description: |
  **MINIMUM 10 QUERIES REQUIRED** for meaningful consensus analysis.
  
  ❌ BAD: ["best tool"]
  ✅ GOOD: 10 diverse queries covering:
  1. Direct topic (3-5 queries)
  2. Recommendations (3-5 queries)
  3. Specific tools (5-10 queries)
  4. Comparisons (3-5 queries)
  5. Alternatives (3-5 queries)
  6. Subreddits (5-10 queries)
  7. Problems (3-5 queries)
  8. Year-specific (2-3 queries)
  9. Features (3-5 queries)
  10. Developer/GitHub (3-5 queries)

validation_rules:
  - rule: query_count
    min: 10
    error: "Only {count} queries provided. MINIMUM 10 required..."
  
  - rule: query_diversity
    max_similarity: 0.7
    error: "Queries too similar ({similarity}% overlap)..."
```

---

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| deep_research avg keywords | 5-8 | 15+ |
| search_reddit avg queries | 1-3 | 10-20 |
| scrape_links use_llm usage | 10% | 80%+ |
| file_attachments with description | 20% | 90%+ |
| Overall tool effectiveness | 60% | 95%+ |

---

## Next Actions

1. **Immediate:** Enhance `search_reddit` in tools.yaml (biggest impact)
2. **High Priority:** Implement validator infrastructure
3. **Medium Priority:** Enhance remaining tools
4. **Low Priority:** Add comprehensive testing

See `06-validation-system-design.md` for full technical specification.
