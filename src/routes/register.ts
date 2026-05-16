// Wave 2 T1-PROXY-B owns full implementation.
import { Router } from 'express';

const router = Router();

router.post('/', (_req, res) => {
  res.status(501).json({ error: 'not implemented — Wave 2 T1-PROXY-B' });
});

export default router;
