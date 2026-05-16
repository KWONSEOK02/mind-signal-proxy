import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import type { PendingRegistry } from '../services/pending-registry';

/**
 * Forwarder function type — POST the verbatim payload to a single DE's
 * /control/assign-group endpoint with the X-Engine-Secret header.
 *
 * Resolves on any HTTP response (including non-2xx).
 * Rejects only on transport-level errors (connection refused, ECONNRESET, etc.).
 */
export interface AssignGroupForwarder {
  (deUrl: string, payload: unknown, engineSecret: string): Promise<{ status: number }>;
}

/** Default fetch-based forwarder implementation. */
const defaultForwarder: AssignGroupForwarder = async (
  deUrl: string,
  payload: unknown,
  engineSecret: string,
): Promise<{ status: number }> => {
  const res = await fetch(`${deUrl}/control/assign-group`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Engine-Secret': engineSecret,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status };
};

/**
 * Minimal body schema: the payload must contain at least { group_id: string }.
 * The FULL req.body is forwarded verbatim — NOT parsed.data — (ADR §C no mutation);
 * the Zod schema validates presence of group_id only.
 */
const AssignGroupBodySchema = z.object({
  group_id: z.string(),
});

/**
 * Create the Express Router for the `/control/assign-group` endpoint.
 *
 * BE calls POST /control/assign-group; the proxy fans out the verbatim payload
 * to every registered DE via the forward function (R1 per-target isolation via
 * Promise.all — each promise already catches internally, so one DE failure does
 * NOT block others).
 *
 * Auth: inbound `x-engine-secret` header must match engineSecret (D14).
 * Outbound: X-Engine-Secret header is attached to every DE forward call (R1-9).
 *
 * @param registry  PendingRegistry with the current set of registered DEs.
 * @param opts      Optional overrides for engineSecret and forward function (test injection).
 */
export function createControlAssignGroupRouter(
  registry: PendingRegistry,
  opts?: { engineSecret?: string; forward?: AssignGroupForwarder },
): Router {
  const engineSecret = opts?.engineSecret ?? config.ENGINE_SECRET_KEY;
  const forward = opts?.forward ?? defaultForwarder;

  const router = Router();

  router.post('/', async (req, res) => {
    // Auth: verify x-engine-secret header.
    // Empty secret = misconfig → fail-closed deny (D14).
    const inboundSecret = req.headers['x-engine-secret'];
    if (engineSecret === '' || inboundSecret !== engineSecret) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Validate that body contains at minimum { group_id: string }.
    const parsed = AssignGroupBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.issues });
      return;
    }

    // Snapshot the current DE registrations.
    const targets = registry.entries();

    if (targets.length === 0) {
      res.status(200).json({ forwarded: [] });
      return;
    }

    // Fan-out to all DEs concurrently (R1 per-target isolation).
    // Each promise catches internally, so Promise.all never rejects: one DE
    // failure returns ok:false without blocking the others.
    // The FULL req.body is forwarded verbatim — ADR §C no mutation.
    const body: unknown = req.body;
    const promises = targets.map(({ subjectIdx, deUrl }) =>
      forward(deUrl, body, engineSecret)
        .then(({ status }): { subjectIdx: number; ok: true; status: number } => ({
          subjectIdx,
          ok: true,
          status,
        }))
        .catch((err: unknown): { subjectIdx: number; ok: false; error: string } => ({
          subjectIdx,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })),
    );

    const forwarded = await Promise.all(promises);

    res.status(200).json({ forwarded });
  });

  return router;
}
