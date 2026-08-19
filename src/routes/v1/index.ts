import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { health } from './health';
import { bookmarks } from './bookmarks';
import { search } from './search';
import { tags } from './tags';
import { categories } from './categories';

export const v1 = new Hono<AppEnv>();

v1.route('/health', health);
v1.route('/bookmarks', bookmarks);
v1.route('/search', search);
v1.route('/tags', tags);
v1.route('/categories', categories);
