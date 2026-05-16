import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import type { PendingRegistry } from '../services/pending-registry';

/**
 * Body schema for DE self-registration.
 *
 * subject_idx: integer identifying the subject this DE is recording.
 * de_url:      non-empty base URL at which the DE can be reached by the proxy.
 */
const RegisterBodySchema = z.object({
  subject_idx: z.number().int(),
  de_url: z.string().min(1),
});

/**
 * Create the Express Router for the `/register` endpoint.
 *
 * DEs call POST /register to register their URL with the proxy.  The proxy
 * uses this mapping when forwarding BE assign-group commands to all registered DEs.
 *
 * Auth: inbound `x-engine-secret` header must match engineSecret (D14 shared secret).
 *
 * @param registry      PendingRegistry instance to populate on valid registration.
 * @param engineSecret  Expected secret.  Defaults to config.ENGINE_SECRET_KEY.
 */
export function createRegisterRouter(
  registry: PendingRegistry,
  engineSecret: string = config.ENGINE_SECRET_KEY,
): Router {
  const router = Router();

  router.post('/', (req, res) => {
    // Auth: verify x-engine-secret header.
    // Empty secret = misconfig → fail-closed deny (D14).
    const inboundSecret = req.headers['x-engine-secret'];
    if (engineSecret === '' || inboundSecret !== engineSecret) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Validate body.
    const parsed = RegisterBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.issues });
      return;
    }

    const { subject_idx, de_url } = parsed.data;
    registry.register(subject_idx, de_url);
    res.status(200).json({ ok: true });
  });

  return router;
}
