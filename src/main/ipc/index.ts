import { app } from 'electron';
import { getConfig, deleteSecret, hasSecret, setSecret, updateConfig } from '../config';
import { dbHealth } from '../db';
import { cancelStream, startChat, testRole } from '../llm';
import { clearCache, fetchUrl, search } from '../search';
import { getAppPaths } from '../paths';
import { handle } from './bridge';

export function registerIpcHandlers(): void {
  handle('app:getPaths', () => getAppPaths());
  handle('app:getVersion', () => app.getVersion());

  handle('config:get', () => getConfig());
  handle('config:update', (next) => updateConfig(next));
  handle('config:setSecret', ({ ref, value }) => setSecret(ref, value));
  handle('config:hasSecret', ({ ref }) => hasSecret(ref));
  handle('config:deleteSecret', ({ ref }) => deleteSecret(ref));

  handle('llm:testRole', ({ role }) => testRole(role));
  handle('llm:chat', (req) => startChat(req));
  handle('llm:cancel', ({ streamId }) => cancelStream(streamId));

  handle('search:query', (req) => search(req));
  handle('search:fetchUrl', (req) => fetchUrl(req));
  handle('search:clearCache', () => ({ removed: clearCache() }));

  handle('db:health', () => dbHealth());
}

export { emit, handle } from './bridge';
