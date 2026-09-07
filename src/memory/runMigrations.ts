/* Standalone entrypoint: `npm run migrate` — opens the configured database and applies migrations. */
import { getDb, closeDb } from './db';
import { logger } from '../logger';

getDb();
logger.info('migrations up to date');
closeDb();
