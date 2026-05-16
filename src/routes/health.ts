import { Router } from 'express';
import { version } from '../../package.json';

const router = Router();

router.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', version });
});

export default router;
