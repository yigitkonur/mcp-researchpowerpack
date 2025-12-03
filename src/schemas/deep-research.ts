/**
 * Deep research schema - batch research with dynamic token allocation
 * Enhanced with comprehensive prompting for bugs, programming questions, and general research
 */

import { z } from 'zod';

// File attachment schema with comprehensive descriptions to guide LLM usage
const fileAttachmentSchema = z.object({
  path: z
    .string({ required_error: 'deep_research: File path is required' })
    .min(1, { message: 'deep_research: File path cannot be empty' })
    .describe(
      `**[REQUIRED] Absolute file path to attach.**

⚠️ **YOU MUST USE ABSOLUTE PATHS** - e.g., "/Users/john/project/src/utils/auth.ts" NOT "src/utils/auth.ts"

The file will be read from the filesystem and included as context for the research question. This is CRITICAL for:
- Bug investigations (attach the failing code)
- Code reviews (attach the code to review)
- Refactoring questions (attach current implementation)
- Architecture decisions (attach relevant modules)
- Performance issues (attach the slow code path)

**IMPORTANT:** Always use the full absolute path as shown in your IDE or terminal.`
    ),
  start_line: z
    .number({ invalid_type_error: 'deep_research: start_line must be a number' })
    .int({ message: 'deep_research: start_line must be an integer' })
    .positive({ message: 'deep_research: start_line must be a positive integer (1-indexed)' })
    .optional()
    .describe(
      `**[OPTIONAL] Start line number (1-indexed).**

Use this to focus on a specific section of a large file. If omitted, reads from line 1.
Example: start_line=50 with end_line=100 reads lines 50-100 only.`
    ),
  end_line: z
    .number({ invalid_type_error: 'deep_research: end_line must be a number' })
    .int({ message: 'deep_research: end_line must be an integer' })
    .positive({ message: 'deep_research: end_line must be a positive integer (1-indexed)' })
    .optional()
    .describe(
      `**[OPTIONAL] End line number (1-indexed).**

Use this to limit the scope to relevant code sections. If omitted, reads to end of file.
For large files (>500 lines), consider specifying a range to focus the research.`
    ),
  description: z
    .string()
    .optional()
    .describe(
      `**[HIGHLY RECOMMENDED] Comprehensive description of why this file is attached and what to focus on.**

⚠️ **THIS IS CRITICAL FOR EFFECTIVE RESEARCH.** Write a detailed description explaining:

1. **What this file is:** "This is the main authentication middleware that handles JWT validation"
2. **Why it's relevant:** "The bug occurs when tokens expire during long-running requests"
3. **What to focus on:** "Pay attention to the refreshToken() function on lines 45-80"
4. **Known issues/context:** "We suspect the race condition happens in the async validation"
5. **Related files:** "This interacts with /src/services/token-service.ts for token refresh"

**GOOD EXAMPLE:**
"This is our Redis caching layer (cache-service.ts). The bug manifests as stale data being returned after cache invalidation. Focus on the invalidatePattern() method (lines 120-150) and how it interacts with the pub/sub mechanism. We're using Redis Cluster and suspect the issue is related to cross-node invalidation timing."

**BAD EXAMPLE:**
"cache file" ← Too vague, research will be unfocused`
    ),
});

// Research question schema with structured template guidance
const researchQuestionSchema = z.object({
  question: z
    .string({ required_error: 'deep_research: Question is required' })
    .min(10, { message: 'deep_research: Question must be at least 10 characters' })
    .describe(
      `**[REQUIRED] Your research question - MUST follow this structured template:**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **STRUCTURED QUESTION TEMPLATE** (You MUST use this format)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**1. 🎯 WHAT I NEED:**
[Clearly state what you're trying to achieve, solve, or understand]

**2. 🤔 WHY I'M RESEARCHING THIS:**
[Explain the context - what decision does this inform? What problem are you solving?]

**3. 📚 WHAT I ALREADY KNOW:**
[Share your current understanding so research fills gaps, not repeats basics]

**4. 🔧 HOW I PLAN TO USE THIS:**
[Describe the practical application - implementation, debugging, architecture, etc.]

**5. ❓ SPECIFIC QUESTIONS (2-5):**
- Question 1: [Specific, pointed question]
- Question 2: [Another specific question]
- Question 3: [etc.]

**6. 🌐 PRIORITY SOURCES (optional):**
[Sites/docs to prioritize: "Prefer official React docs, GitHub issues, Stack Overflow"]

**7. ⚡ PRIORITY INFO (optional):**
[What matters most: "Focus on performance implications" or "Prioritize security best practices"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**EXAMPLE FOR BUG INVESTIGATION:**
"🎯 WHAT I NEED: Debug why our WebSocket connections drop after exactly 60 seconds of inactivity.

🤔 WHY: Production users are losing real-time updates, causing data sync issues and support tickets.

📚 WHAT I KNOW: We use Socket.io v4.6 with Redis adapter. The 60s timeout suggests a proxy/load balancer issue, but we've checked nginx configs.

🔧 HOW I'LL USE THIS: Implement the fix in our connection-manager.ts (attached) and update our deployment configs.

❓ SPECIFIC QUESTIONS:
1. What are common causes of exactly 60-second WebSocket timeouts?
2. How should Socket.io heartbeat/ping intervals be configured to prevent this?
3. Are there AWS ALB-specific settings we need to consider?
4. How do other production apps handle WebSocket keep-alive?

🌐 PRIORITY: Socket.io official docs, AWS documentation, GitHub issues with similar problems

⚡ FOCUS: Production-ready solutions, not development workarounds"

**EXAMPLE FOR ARCHITECTURE RESEARCH:**
"🎯 WHAT I NEED: Best practices for implementing CQRS pattern with Event Sourcing in Node.js/TypeScript.

🤔 WHY: Our monolithic API is hitting scaling limits. We need to separate read/write paths for our order processing system.

📚 WHAT I KNOW: Familiar with basic event-driven architecture, used RabbitMQ before. New to full CQRS/ES implementation.

🔧 HOW I'LL USE THIS: Design the new order-service architecture, select appropriate libraries, plan migration strategy.

❓ SPECIFIC QUESTIONS:
1. What are the recommended Node.js libraries for CQRS/ES? (Pros/cons of each)
2. How should we handle eventual consistency in read models?
3. What's the best event store for our scale (~10k events/day)?
4. How do we handle schema evolution for events over time?
5. What are common pitfalls teams encounter when adopting CQRS/ES?

🌐 PRIORITY: Microsoft docs (they coined CQRS), Martin Fowler, real-world case studies

⚡ FOCUS: Production patterns, not theoretical explanations. Include code examples."`
    ),
  file_attachments: z
    .array(fileAttachmentSchema)
    .optional()
    .describe(
      `**[CRITICAL FOR BUGS/CODE QUESTIONS] File attachments to include as research context.**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ **YOU MUST ATTACH FILES WHEN:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **MANDATORY file attachment scenarios:**
- 🐛 **Bug investigation** → Attach the buggy code file(s)
- 🔍 **Code review** → Attach the code to be reviewed
- ♻️ **Refactoring** → Attach current implementation
- 🏗️ **Architecture questions about YOUR code** → Attach relevant modules
- ⚡ **Performance issues** → Attach the slow code paths
- 🔒 **Security review** → Attach the security-sensitive code
- 🧪 **Testing questions** → Attach both the code AND test files
- 🔗 **Integration issues** → Attach files from both sides of the integration

❌ **File attachments NOT needed for:**
- General concept questions ("What is CQRS?")
- Technology comparisons ("React vs Vue")
- Best practices research (unless about your specific code)
- Documentation lookups

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📎 **HOW TO ATTACH FILES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Each attachment requires:**
1. \`path\` (REQUIRED): **Absolute path** like "/Users/dev/project/src/auth.ts"
2. \`start_line\` (optional): Focus on specific section
3. \`end_line\` (optional): Limit scope for large files
4. \`description\` (HIGHLY RECOMMENDED): Explain what this file is and why it matters

**EXAMPLE - Bug with multiple related files:**
\`\`\`json
{
  "question": "🎯 WHAT I NEED: Fix the race condition in our order processing...",
  "file_attachments": [
    {
      "path": "/Users/dev/ecommerce/src/services/order-processor.ts",
      "description": "Main order processing service. The race condition occurs in processOrder() when two requests hit simultaneously. Lines 45-120 contain the critical section."
    },
    {
      "path": "/Users/dev/ecommerce/src/repositories/inventory-repo.ts",
      "start_line": 30,
      "end_line": 80,
      "description": "Inventory repository - the decrementStock() method (lines 30-80) is called by order-processor and we suspect it's not properly locked."
    },
    {
      "path": "/Users/dev/ecommerce/src/utils/db-transaction.ts",
      "description": "Our transaction wrapper utility. Need to verify if it properly handles concurrent transactions."
    }
  ]
}
\`\`\`

**Attach as many files as needed for complete context - there is no limit!**`
    ),
});

// Shape object for external consumers who need individual field schemas
const deepResearchParamsShape = {
  questions: z
    .array(researchQuestionSchema, { 
      required_error: 'deep_research: Questions array is required',
      invalid_type_error: 'deep_research: Questions must be an array'
    })
    .min(1, { message: 'deep_research: At least 1 question is required (recommend 2-7 for optimal depth)' })
    .max(10, { message: 'deep_research: Maximum 10 questions allowed per batch' })
    .describe(
      `**Batch deep research (2-10 questions) with dynamic token allocation.**

**TOKEN BUDGET:** 32,000 tokens distributed across all questions:
- 2 questions: 16,000 tokens/question (deep dive)
- 5 questions: 6,400 tokens/question (balanced)
- 10 questions: 3,200 tokens/question (rapid multi-topic)

**WHEN TO USE:**
- Need multi-perspective analysis on related topics
- Researching a domain from multiple angles
- Validating understanding across different aspects
- Comparing approaches/technologies side-by-side

**EACH QUESTION SHOULD INCLUDE:**
- Topic & context (what decision it informs)
- Your current understanding (to fill gaps)
- Specific sub-questions (2-5 per topic)

**USE:** Maximize question count for comprehensive coverage. All questions run in parallel. Group related questions for coherent research.`
    ),
};

export const deepResearchParamsSchema = z.object(deepResearchParamsShape);
export type DeepResearchParams = z.infer<typeof deepResearchParamsSchema>;
