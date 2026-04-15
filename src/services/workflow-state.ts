import { createClient } from 'redis';

export interface WorkflowState {
  bootstrapped: boolean;
  bootstrappedAt?: string;
  redditWarningShown: boolean;
  orientationVersion: 1;
}

export interface WorkflowStateStore {
  get(key: string): Promise<WorkflowState>;
  patch(key: string, patch: Partial<WorkflowState>): Promise<WorkflowState>;
  close?(): Promise<void>;
}

const WORKFLOW_STATE_TTL_SECONDS = 60 * 60 * 24;
const WORKFLOW_STATE_PREFIX = 'research-pack:workflow:';

export function emptyWorkflowState(): WorkflowState {
  return {
    bootstrapped: false,
    redditWarningShown: false,
    orientationVersion: 1,
  };
}

export function createMemoryWorkflowStateStore(): WorkflowStateStore {
  const states = new Map<string, WorkflowState>();

  return {
    async get(key) {
      return states.get(key) ?? emptyWorkflowState();
    },
    async patch(key, patch) {
      const current = states.get(key) ?? emptyWorkflowState();
      const next: WorkflowState = {
        ...current,
        ...patch,
        orientationVersion: 1,
      };
      states.set(key, next);
      return next;
    },
  };
}

class RedisWorkflowStateStore implements WorkflowStateStore {
  constructor(
    private readonly client: {
      get(key: string): Promise<string | null>;
      set(
        key: string,
        value: string,
        options: { EX: number },
      ): Promise<unknown>;
      quit(): Promise<unknown>;
    },
    private readonly prefix = WORKFLOW_STATE_PREFIX,
  ) {}

  async get(key: string): Promise<WorkflowState> {
    const raw = await this.client.get(this.prefix + key);
    if (!raw) {
      return emptyWorkflowState();
    }

    const parsed = JSON.parse(raw) as Partial<WorkflowState>;
    return {
      ...emptyWorkflowState(),
      ...parsed,
      orientationVersion: 1,
    };
  }

  async patch(key: string, patch: Partial<WorkflowState>): Promise<WorkflowState> {
    const next: WorkflowState = {
      ...(await this.get(key)),
      ...patch,
      orientationVersion: 1,
    };

    await this.client.set(this.prefix + key, JSON.stringify(next), {
      EX: WORKFLOW_STATE_TTL_SECONDS,
    });

    return next;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

let workflowStateStore: WorkflowStateStore | null = null;

export async function configureWorkflowStateStore(redisUrl: string | undefined): Promise<void> {
  if (workflowStateStore) {
    return;
  }

  if (!redisUrl) {
    workflowStateStore = createMemoryWorkflowStateStore();
    return;
  }

  const client = createClient({ url: redisUrl });
  await client.connect();
  workflowStateStore = new RedisWorkflowStateStore(client);
}

export function getWorkflowStateStore(): WorkflowStateStore {
  if (!workflowStateStore) {
    throw new Error('WorkflowStateStore not configured');
  }

  return workflowStateStore;
}

export async function closeWorkflowStateStore(): Promise<void> {
  await workflowStateStore?.close?.();
  workflowStateStore = null;
}
