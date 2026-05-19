import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import type { PendingRegistry } from '../services/pending-registry';
import type { BeNotifierPort } from '../services/be-notifier';

/**
 * Body schema for DE self-registration.
 *
 * subject_idx: 1 or 2 — the subject this DE is recording (BE subjectIndex mirror).
 * de_url:      DE base URL (must be a valid URL — BE engineUrl mirror).
 */
const RegisterBodySchema = z.object({
  subject_idx: z.union([z.literal(1), z.literal(2)]),
  de_url: z.string().url(),
});

/**
 * Create the Express Router for the `/register` endpoint.
 *
 * DEs call POST /register to register their URL with the proxy. The proxy uses
 * this mapping when forwarding BE assign-group commands to all registered DEs.
 * On a valid registration the proxy also mirrors the pending entry to BE via
 * beNotifier (control-plane, fire-and-forget — ADR-phase18-002).
 *
 * Auth: inbound `x-engine-secret` header must match engineSecret (D14 shared secret).
 *
 * @param registry  PendingRegistry instance to populate on valid registration.
 * @param opts      Optional engineSecret override and BeNotifier port (test injection).
 */
export function createRegisterRouter(
  registry: PendingRegistry,
  opts?: { engineSecret?: string; beNotifier?: BeNotifierPort },
): Router {
  const engineSecret = opts?.engineSecret ?? config.ENGINE_SECRET_KEY;
  const beNotifier = opts?.beNotifier;
  const router = Router();

  router.post('/', (req, res) => {
    // Auth: verify x-engine-secret header.
    // Empty secret = misconfig: fail-closed deny (D14).
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
    try {
      beNotifier?.notifyRegister({ subjectIndex: subject_idx, engineUrl: de_url });
    } catch (e) {
      // CX-3 방어: 주입 포트가 동기 throw해도 라우트 200 보존 (port 계약은 누출 0이나 mock/오구현 대비)
      console.error('[register] beNotifier.notifyRegister sync throw (라우트 200 유지):', e);
    }
    res.status(200).json({ ok: true });
  });

  return router;
}
