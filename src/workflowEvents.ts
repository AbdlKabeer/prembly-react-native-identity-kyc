import type { WorkflowEnd, WorkflowEvent } from './types';

const END_STATES: readonly string[] = ['completed', 'failed', 'manual_review', 'expired'];

export const isEndState = (type: string): type is WorkflowEnd => END_STATES.includes(type);

/**
 * A message from the hosted workflow, as the envelope the web SDK documents
 * (`{ source: 'prembly-sdk', product: 'workflow', type, session_id, node_id? }`), plus the legacy
 * `prembly-workflow-sdk` shape. Anything else (another product, another source, bad JSON) is null.
 */
export function parseWorkflowMessage(raw: string): WorkflowEvent | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const current = data.source === 'prembly-sdk' && data.product === 'workflow';
  const legacy = data.source === 'prembly-workflow-sdk';
  if (!current && !legacy) return null;
  if (typeof data.type !== 'string' || typeof data.session_id !== 'string') return null;
  return {
    type: data.type,
    sessionId: data.session_id,
    ...(typeof data.node_id === 'string' ? { nodeId: data.node_id } : {}),
  };
}
