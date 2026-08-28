import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';

export const health = new Hono<AppEnv>();

health.get('/', (c) => c.json({ ok: true, service: 'bookmark-sync-engine' }));
