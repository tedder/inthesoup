import { NextApiRequest, NextApiResponse } from 'next';
import { getBackendName } from '../../lib/db';
import { getDuckDbHealth } from '../../lib/health';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');

  let backend: string;
  try {
    backend = getBackendName();
  } catch (err) {
    res.status(500).json({ status: 'error', error: (err as Error).message });
    return;
  }

  if (backend === 'bigquery') {
    res.status(200).json({ backend: 'bigquery' });
    return;
  }

  const { httpStatus, body } = getDuckDbHealth(process.env.DATA_DIR || '/data');
  res.status(httpStatus).json(body);
}
